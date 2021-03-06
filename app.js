//
// Copyright (c) 2011 Mashery, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// 'Software'), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

//
// Module dependencies
//
var express     = require('express'),
    util        = require('util'),
    fs          = require('fs'),
    OAuth       = require('oauth').OAuth,
    query       = require('querystring'),
    url         = require('url'),
    http        = require('http'),
    https       = require('https'),
    crypto      = require('crypto'),
    redis       = require('redis'),
    RedisStore  = require('connect-redis')(express);

// Configuration
try {
    var configJSON = fs.readFileSync(__dirname + "/config.json");
    var config = JSON.parse(configJSON.toString());
} catch(e) {
    console.error("File config.json not found or is invalid.  Try: `cp config.json.sample config.json`");
    process.exit(1);
}

// CORE UPDATE: update config object to use Heroku RedisToGo
if (process.env.REDISTOGO_URL) {
	// use production (Heroku) redis configuration
	// overwrite `config` to keep it simple
	var rtg = require('url').parse(process.env.REDISTOGO_URL);
	config.redis.port = rtg.port;
	config.redis.host = rtg.hostname;
	config.redis.password = rtg.auth.split(":")[1];
}

//
// Redis connection
//
var defaultDB = '0';
var db = redis.createClient(config.redis.port, config.redis.host);
db.auth(config.redis.password);

db.on("error", function(err) {
    if (config.debug) {
         console.log("Error " + err);
    }
});

//
// Load API Configs
//
var apisConfig;
fs.readFile(__dirname + '/public/data/apiconfig.json', 'utf-8', function(err, data) {
    if (err) throw err;
    apisConfig = JSON.parse(data);
    if (config.debug) {
         console.log(util.inspect(apisConfig));
    }
});

var app = module.exports = express.createServer();

app.configure(function() {
    app.set('views', __dirname + '/views');
    app.set('view engine', 'jade');
    app.use(express.logger());
    app.use(express.bodyParser());
    app.use(express.methodOverride());
    app.use(express.cookieParser());
    app.use(express.session({
        secret: config.sessionSecret,
        store:  new RedisStore({
            'host':   config.redis.host,
            'port':   config.redis.port,
            'pass':   config.redis.password,
            'maxAge': 1209600000
        })
    }));

    app.use(app.router);

    app.use(express.static(__dirname + '/public'));
});

app.configure('development', function() {
    app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function() {
    app.use(express.errorHandler());
});

//
// Middleware
//
function oauth(req, res, next) {
    var apiName = req.body.apiName,
        apiConfig = apisConfig[apiName];

    if (apiConfig.auth.oauth) {
    	console.log('OAuth process started');
        var apiKey = req.body.oauthKey,
            apiSecret = req.body.oauthSecret,
            refererURL = url.parse(req.headers.referer),
            callbackURL = refererURL.protocol + '//' + refererURL.host + '/authSuccess/' + apiName,
            oa = new OAuth(apiConfig.auth.oauth.requestURL,
                           apiConfig.auth.oauth.accessURL,
                           apiKey,
                           apiSecret,
                           apiConfig.auth.oauth.version,
                           callbackURL,
                           apiConfig.auth.oauth.crypt);

        if (config.debug) {
            console.log('OAuth type: ' + apiConfig.auth.oauth.type);
            console.log('Method security: ' + req.body.oauth);
            console.log('Session authed: ' + req.session[apiName]);
            console.log('apiKey: ' + apiKey);
            console.log('apiSecret: ' + apiSecret);
        };

        // Check if the API even uses OAuth, then if the method requires oauth, then if the session is not authed
        if (apiConfig.auth.oauth.type == 'three-legged' && req.body.oauth == 'authrequired' && (!req.session[apiName] || !req.session[apiName].authed) ) {
            if (config.debug) {
                console.log('req.session: ' + util.inspect(req.session));
                console.log('headers: ' + util.inspect(req.headers));

                console.log(util.inspect(oa));
                // console.log(util.inspect(req));
                console.log('sessionID: ' + util.inspect(req.sessionID));
                // console.log(util.inspect(req.sessionStore));
            };

            oa.getOAuthRequestToken(function(err, oauthToken, oauthTokenSecret, results) {
                if (err) {
                    res.send("Error getting OAuth request token : " + util.inspect(err), 500);
                } else {
                    // Unique key using the sessionID and API name to store tokens and secrets
                    var key = req.sessionID + ':' + apiName;

                    db.set(key + ':apiKey', apiKey, redis.print);
                    db.set(key + ':apiSecret', apiSecret, redis.print);

                    db.set(key + ':requestToken', oauthToken, redis.print);
                    db.set(key + ':requestTokenSecret', oauthTokenSecret, redis.print);

                    // Set expiration to same as session
                    db.expire(key + ':apiKey', 1209600000);
                    db.expire(key + ':apiSecret', 1209600000);
                    db.expire(key + ':requestToken', 1209600000);
                    db.expire(key + ':requestTokenSecret', 1209600000);

                    // res.header('Content-Type', 'application/json');
                    res.send({ 'signin': apiConfig.auth.oauth.signinURL + oauthToken });
                }
            });
        } else if (apiConfig.auth.oauth.type == 'two-legged' && req.body.oauth == 'authrequired') {
            // Two legged stuff... for now nothing.
            next();
        } else {
            next();
        }
    } else {
        next();
    }

}

//
// OAuth Success!
//
function oauthSuccess(req, res, next) {
    var oauthRequestToken,
        oauthRequestTokenSecret,
        apiKey,
        apiSecret,
        apiName = req.params.api,
        apiConfig = apisConfig[apiName],
        key = req.sessionID + ':' + apiName; // Unique key using the sessionID and API name to store tokens and secrets

    if (config.debug) {
        console.log('apiName: ' + apiName);
        console.log('key: ' + key);
        console.log(util.inspect(req.params));
    };

    db.mget([
        key + ':requestToken',
        key + ':requestTokenSecret',
        key + ':apiKey',
        key + ':apiSecret'
    ], function(err, result) {
        if (err) {
            console.log(util.inspect(err));
        }
        oauthRequestToken = result[0],
        oauthRequestTokenSecret = result[1],
        apiKey = result[2],
        apiSecret = result[3];

        if (config.debug) {
            console.log(util.inspect(">>"+oauthRequestToken));
            console.log(util.inspect(">>"+oauthRequestTokenSecret));
            console.log(util.inspect(">>"+req.query.oauth_verifier));
        };

        var oa = new OAuth(apiConfig.auth.oauth.requestURL,
                           apiConfig.auth.oauth.accessURL,
                           apiKey,
                           apiSecret,
                           apiConfig.auth.oauth.version,
                           null,
                           apiConfig.auth.oauth.crypt);

        if (config.debug) {
            console.log(util.inspect(oa));
        };

        oa.getOAuthAccessToken(oauthRequestToken, oauthRequestTokenSecret, req.query.oauth_verifier, function(error, oauthAccessToken, oauthAccessTokenSecret, results) {
            if (error) {
                res.send("Error getting OAuth access token : " + util.inspect(error) + "["+oauthAccessToken+"]"+ "["+oauthAccessTokenSecret+"]"+ "["+util.inspect(results)+"]", 500);
            } else {
                if (config.debug) {
                    console.log('results: ' + util.inspect(results));
                };
                db.mset([key + ':accessToken', oauthAccessToken,
                    key + ':accessTokenSecret', oauthAccessTokenSecret
                ], function(err, results2) {
                    req.session[apiName] = {};
                    req.session[apiName].authed = true;
                    if (config.debug) {
                        console.log('session[apiName].authed: ' + util.inspect(req.session));
                    };

                    next();
                });
            }
        });

    });
}

//
// processRequest - handles API call
//
function processRequest(req, res, next) {
    if (config.debug) {
        console.log(util.inspect(req.body, null, 3));
    };

    var params = req.body.params || {},
        paramTypes = req.body.paramTypes || {},
        methodURL = req.body.methodUri,
        httpMethod = req.body.httpMethod,
        dataFormat = req.body.dataFormat,
        apiKey = req.body.apiKey,
        apiName = req.body.apiName
        apiConfig = apisConfig[apiName],
        key = req.sessionID + ':' + apiName,
        baseHostInfo = apiConfig.baseURL.split(':'),
        baseHostUrl = baseHostInfo[0],
        baseHostPort = (baseHostInfo.length > 1) ? baseHostInfo[1] : "";
        

    // Update params
    // Replace placeholders in the methodURL with matching params
    // TODO: needs to be recursive for new nested parameters
    for (var param in params) {
        if (params.hasOwnProperty(param)) {
            if (params[param] !== '') {
                // URL params are prepended with ":"
                var regx = new RegExp(':' + param);

                // If the param is actually a part of the URL, put it in the URL and remove the param
                if (!!regx.test(methodURL)) {
                    methodURL = methodURL.replace(regx, params[param]);
                    delete params[param]
                }
                else if (paramTypes[param] == 'json') {
                	params[param] = JSON.parse(params[param])
                }
                else if (paramTypes[param] == 'list') {
                	params[param] = params[param].split(',');
                }
            }
            else {
                delete params[param]; // Delete blank params
            }
        }
    }

    var privateReqURL = apiConfig.protocol + '://' + apiConfig.baseURL + apiConfig.privatePath + methodURL,
    options = {
    		headers: {},
    		protocol: apiConfig.protocol + ':',
    		host: baseHostUrl,
    		port: baseHostPort,
    		method: httpMethod,
    		path: apiConfig.publicPath + methodURL
    };

    // TODO: use case for privateReqURL vs. options.path
    if (httpMethod == 'GET' && Object.keys(params).length) {
    	privateReqURL += '?' + query.stringify(params);
    	options.path += '?' + query.stringify(params);
    }
    
    
    // Add API Key to params, if any.
    if (apiKey) {
        if (options.method == 'GET' || options.method == 'DELETE' || apiConfig.auth.key.forceQueryString) {
            options.path += (options.path.indexOf('?') === -1 ? '?' : '&') + apiConfig.auth.key.param + '=' + apiKey;
        }
        else {
        	params[apiConfig.auth.key.param] = apiKey 
        }   
    }

    if (apiConfig.auth.oauth) {
        console.log('Using OAuth');

        // Three legged OAuth
        if (apiConfig.auth.oauth.type == 'three-legged' && (req.body.oauth == 'authrequired' || (req.session[apiName] && req.session[apiName].authed))) {
            if (config.debug) {
                console.log('Three Legged OAuth');
            };

            db.mget([key + ':apiKey',
                     key + ':apiSecret',
                     key + ':accessToken',
                     key + ':accessTokenSecret'
                ],
                function(err, results) {

                    var apiKey = (typeof req.body.apiKey == "undefined" || req.body.apiKey == "undefined")?results[0]:req.body.apiKey,
                        apiSecret = (typeof req.body.apiSecret == "undefined" || req.body.apiSecret == "undefined")?results[1]:req.body.apiSecret,
                        accessToken = results[2],
                        accessTokenSecret = results[3];
                    console.log(apiKey);
                    console.log(apiSecret);
                    console.log(accessToken);
                    console.log(accessTokenSecret);
                    
                    var oa = new OAuth(apiConfig.auth.oauth.requestURL || null,
                                       apiConfig.auth.oauth.accessURL || null,
                                       apiKey || null,
                                       apiSecret || null,
                                       apiConfig.auth.oauth.version || null,
                                       null,
                                       apiConfig.auth.oauth.crypt);

                    if (config.debug) {
                        console.log('Access token: ' + accessToken);
                        console.log('Access token secret: ' + accessTokenSecret);
                        console.log('key: ' + key);
                    };

                    oa.getProtectedResource(privateReqURL, httpMethod, accessToken, accessTokenSecret,  function (error, data, response) {
                        req.call = privateReqURL;

						if (config.debug) {
						    console.log(util.inspect(response));
						}

                        if (error) {
                            console.log('Got error: ' + util.inspect(error));

                            if (error.data == 'Server Error' || error.data == '') {
                                req.result = 'Server Error';
                            } else {
                                req.result = error.data;
                            }

                            res.statusCode = error.statusCode

                            next();
                        } else {
                            req.resultHeaders = response.headers;
                            req.result = JSON.parse(data);

                            next();
                        }
                    });
                }
            );
        } else if (apiConfig.auth.oauth.type == 'two-legged' && req.body.oauth == 'authrequired') { // Two-legged
            if (config.debug) {
                console.log('Two Legged OAuth');
            };

            var body,
                oa = new OAuth(null,
                               null,
                               apiKey || null,
                               apiSecret || null,
                               apiConfig.auth.oauth.version || null,
                               null,
                               apiConfig.auth.oauth.crypt);

            var resource = options.protocol + '://' + options.host + options.path,
                cb = function(error, data, response) {
                    if (error) {
                        if (error.data == 'Server Error' || error.data == '') {
                            req.result = 'Server Error';
                        } else {
                            console.log(util.inspect(error));
                            body = error.data;
                        }

                        res.statusCode = error.statusCode;

                    } else {
                        console.log(util.inspect(data));

                        var responseContentType = response.headers['content-type'];

                        switch (true) {
                            case /application\/javascript/.test(responseContentType):
                            case /text\/javascript/.test(responseContentType):
                            case /application\/json/.test(responseContentType):
                                body = JSON.parse(data);
                                break;
                            case /application\/xml/.test(responseContentType):
                            case /text\/xml/.test(responseContentType):
                            default:
                        }
                    }

                    // Set Headers and Call
                    if (response) {
                        req.resultHeaders = response.headers || 'None';
                    } else {
                        req.resultHeaders = req.resultHeaders || 'None';
                    }

                    req.call = url.parse(options.host + options.path);
                    req.call = url.format(req.call);

                    // Response body
                    req.result = body;

                    next();
                };

            switch (httpMethod) {
                case 'GET':
                    console.log(resource);
                    oa.get(resource, '', '',cb);
                    break;
                case 'PUT':
                case 'POST':
                    oa.post(resource, '', '', JSON.stringify(obj), null, cb);
                    break;
                case 'DELETE':
                    oa.delete(resource,'','',cb);
                    break;
            }

        } else {
            // API uses OAuth, but this call doesn't require auth and the user isn't already authed, so just call it.
            unsecuredCall();
        }
    } else {
        // API does not use authentication
        unsecuredCall();
    }

    // Unsecured API Call helper
    function unsecuredCall() {
        console.log('Unsecured Call');

        // Perform signature routine, if any.
        if (apiConfig.signature) {
            if (apiConfig.signature.type == 'signed_md5') {
                // Add signature parameter
                var timeStamp = Math.round(new Date().getTime()/1000);
                var sig = crypto.createHash('md5').update('' + apiKey + req.body.signature + timeStamp + '').digest(apiConfig.signature.digest);
                options.path += '&' + apiConfig.signature.sigParam + '=' + sig;
            }
            else if (apiConfig.signature.type == 'signed_sha256') { // sha256(key+secret+epoch)
                // Add signature parameter
                var timeStamp = Math.round(new Date().getTime()/1000);
                var sig = crypto.createHash('sha256').update('' + apiKey + req.body.signature + timeStamp + '').digest(apiConfig.signature.digest);
                options.path += '&' + apiConfig.signature.sigParam + '=' + sig;
            }
        }
        
        // add cookie to header, if any...
        if (apiConfig.auth.cookie) {
            if (config.debug) {
                console.log('Setting cookie: ' + apiConfig.auth.cookie.name + '=' + req.body.cookieValue);
            }

            if (options.headers['Cookie']) {
            	options.headers['Cookie'] += '; ' + apiConfig.auth.cookie.name + '=' + req.body.cookieValue;
            }
            else {
            	options.headers['Cookie'] = apiConfig.auth.cookie.name + '=' + req.body.cookieValue;
            }
        }        

        // Setup headers, if any...
        // NOTE: priority is: global, resource, code
        if (apiConfig.auth.header && apiConfig.auth.header.length > 0) {
        	for (index in apiConfig.auth.header) {
        		var header = apiConfig.auth.header[index];
        		
                if (req.body.headers[header.name]) {
                    if (config.debug) {
                        console.log('Setting header: ' + header.name + ':' + req.body.headers[header.name]);
                    }

                	options.headers[header.name] = req.body.headers[header.name];
                }
            }
        }
        
        
        if (req.body.headerNames && req.body.headerNames.length > 0) {
            for (var x = 0, len = req.body.headerNames.length; x < len; x++) {
                if (req.body.headerNames[x] != '') {
                    if (config.debug) {
                        console.log('Setting header: ' + req.body.headerNames[x] + ':' + req.body.headerValues[x]);
                    }

                	options.headers[req.body.headerNames[x]] = req.body.headerValues[x];
                }
            }
        }
        
        var sendData = ''
        if (options.method == 'GET' || options.method == 'DELETE') {
            if (!options.headers['Content-Length']) {
                options.headers['Content-Length'] = 0;
            }
        }
        else if (options.method == 'POST' || options.method == 'PUT') {
            if (dataFormat && dataFormat == 'json') {
                options.headers['Content-Type'] = 'application/json';
                sendData = JSON.stringify(params)
            }
            else {
                options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                sendData = query.stringify(params);
            }
        }

        console.log(util.inspect(params));
        
        if (config.debug) {
            console.log(util.inspect(options));
        };
        
        var doRequest;
        if (options.protocol === 'https' || options.protocol === 'https:') {
            console.log('Protocol: HTTPS');
            options.protocol = 'https:'
            doRequest = https.request;
        } else {
            console.log('Protocol: HTTP');
            doRequest = http.request;
        }

        // API Call. response is the response from the API, res is the response we will send back to the user.
        var apiCall = doRequest(options, function(response) {
            response.setEncoding('utf-8');

            if (config.debug) {
                console.log('HEADERS: ' + JSON.stringify(response.headers));
                console.log('STATUS CODE: ' + response.statusCode);
            };

            res.statusCode = response.statusCode;

            var body = '';

            response.on('data', function(data) {
                body += data;
            })

            response.on('end', function() {
                delete options.agent;

                var responseContentType = response.headers['content-type'];

                switch (true) {
                    case /application\/javascript/.test(responseContentType):
                    case /application\/json/.test(responseContentType):
                        console.log(util.inspect(body));
                        // body = JSON.parse(body);
                        break;
                    case /application\/xml/.test(responseContentType):
                    case /text\/xml/.test(responseContentType):
                    default:
                }

                // Set Headers and Call
                req.resultHeaders = response.headers;
                req.call = url.parse(options.host + options.path);
                req.call = url.format(req.call);

                // Response body
                req.result = body;

                console.log(util.inspect(body));

                next();
            })
        }).on('error', function(e) {
            if (config.debug) {
                console.log('HEADERS: ' + JSON.stringify(res.headers));
                console.log("Got error: " + e.message);
                console.log("Error: " + util.inspect(e));
            };
        });

        if (sendData.length) {
            if (config.debug) {
                console.log("Request Body: " + sendData) 
            }

            options.headers['Content-Length'] = Buffer.byteLength(sendData);
            apiCall.end(sendData, 'utf-8');
        }
        else {
            apiCall.end();
        }
    }
}


// Dynamic Helpers
// Passes variables to the view
app.dynamicHelpers({
    session: function(req, res) {
    // If api wasn't passed in as a parameter, check the path to see if it's there
        if (!req.params.api) {
            pathName = req.url.replace('/','');
            // Is it a valid API - if there's a config file we can assume so
            fs.stat(__dirname + '/public/data/' + pathName + '.json', function (error, stats) {
                if (stats) {
                    req.params.api = pathName;
                }
            });
        }       
        // If the cookie says we're authed for this particular API, set the session to authed as well
        if (req.params.api && req.session[req.params.api] && req.session[req.params.api]['authed']) {
            req.session['authed'] = true;
        }

        return req.session;
    },
    apiInfo: function(req, res) {
        if (req.params.api) {
            return apisConfig[req.params.api];
        } else {
            return apisConfig;
        }
    },
    apiName: function(req, res) {
        if (req.params.api) {
            return req.params.api;
        }
    },
    apiDefinition: function(req, res) {
        if (req.params.api) {
            var data = fs.readFileSync(__dirname + '/public/data/' + req.params.api + '.json');
            return JSON.parse(data);
        }
    }
})


//
// Routes
//
app.get('/', function(req, res) {
    res.render('listAPIs', {
        title: config.title
    });
});

// Process the API request
app.post('/processReq', oauth, processRequest, function(req, res) {
    var result = {
        headers: req.resultHeaders,
        response: req.result,
        call: req.call,
        code: req.res.statusCode
    };

    res.send(result);
});

// Just auth
app.all('/auth', oauth);

// OAuth callback page, closes the window immediately after storing access token/secret
app.get('/authSuccess/:api', oauthSuccess, function(req, res) {
    res.render('authSuccess', {
        title: 'OAuth Successful'
    });
});

app.post('/upload', function(req, res) {
  console.log(req.body.user);
  res.redirect('back');
});

app.all(/^\/service(?:\/(\d+))?$/, function(req, res) {
	var response = {
		'request': {
			'url': req.url,
			'method': req.method.toUpperCase(),
			'timestamp': Math.round(+new Date() / 1000),
		},
		'parameters': null
	}

	response.parameters = response.request.method == 'GET' ? url.parse(req.url, true).query : req.body;
	if (req.params[0]) {
		response.parameters['id'] = req.params[0];
	}

	res.send(JSON.stringify(response));
});

// API shortname, all lowercase
app.get('/:api([^\.]+)', function(req, res) {
    req.params.api=req.params.api.replace(/\/$/,'');
    res.render('api');
});


// Only listen on $ node app.js
if (!module.parent) {
    var port = process.env.PORT || config.port;
    app.listen(port);
    console.log("Express server listening on port %d", app.address().port);
}
