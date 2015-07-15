'use strict';

/**
 * Module dependencies
 */

var promise = require('rsvp').Promise;
var r = require('jsrsasign');
var utility = require('./utility.js');
var Cookies = require('cookies');
var url = require('url');

function OidcClient(req, res, serverSettings) {

    if (!(this instanceof OidcClient)) { return new OidcClient(req, res, serverSettings); }

    var self = this;
    
    // if you don't clone, you end up keeping the request / response state on the server level configuration object.
    self._settings = utility.copy(serverSettings);

    utility.verbose_logging = self._settings.verbose_logging || false;

    if (!self._settings.request_state_key) {
        self._settings.request_state_key = "OidcClient.request_state";
    }

    if (!self._settings.request_state_store) {
        self._settings.request_state_store = new Cookies(req, res);
    }

    if (typeof self._settings.load_user_profile === 'undefined') {
        self._settings.load_user_profile = true;
    }

    if (typeof self._settings.filter_protocol_claims === 'undefined') {
        self._settings.filter_protocol_claims = true;
    }

    if (self._settings.authority && self._settings.authority.indexOf('.well-known/openid-configuration') < 0) {
        if (self._settings.authority[self._settings.authority.length - 1] !== '/') {
            self._settings.authority += '/';
        }
        self._settings.authority += '.well-known/openid-configuration';
    }

    if (!self._settings.response_type) {
        self._settings.response_type = "id_token token";
    }
};

function error(message) {
    utility.error(promise, message);
};

OidcClient.prototype = {

    isOidc: function () {
        var self = this;

        if (self._settings.response_type) {
            var result = self._settings.response_type.split(/\s+/g).filter(function (item) {
                return item === "id_token";
            });
            return !!(result[0]);
        }
        return false;
    },

    isOauth: function () {
        var self = this;

        if (self._settings.response_type) {
            var result = self._settings.response_type.split(/\s+/g).filter(function (item) {
                return item === "token";
            });
            return !!(result[0]);
        }
        return false;
    },

    loadMetadataAsync: function () {
        utility.log("OidcClient.loadMetadataAsync");
        var self = this;
        var settings = self._settings;

        if (settings.metadata) {
            return promise.resolve(settings.metadata);
        }

        if (!settings.authority) {
            return error("No authority configured");
        }

        return utility.getJson(settings.authority, null, settings.httpSettings)
            .then(function (metadata) {
                settings.metadata = metadata;
                return metadata;
            }).catch(function (err) {
                return error("Failed to load metadata (" + err.message + ")");
            });
    },

    loadX509SigningKeyAsync: function () {
        utility.log("OidcClient.loadX509SigningKeyAsync");
        var self = this;
        var settings = self._settings;

        function getKeyAsync(jwks) {
            if (!jwks.keys || !jwks.keys.length) {
                return error("Signing keys empty");
            }

            var key = jwks.keys[0];
            if (key.kty !== "RSA") {
                return error("Signing key not RSA");
            }

            if (!key.x5c || !key.x5c.length) {
                return error("RSA keys empty");
            }

            return promise.resolve(key.x5c[0]);
        }

        if (settings.jwks) {
            return getKeyAsync(settings.jwks);
        }

        return self.loadMetadataAsync().then(function (metadata) {
            if (!metadata.jwks_uri) {
                return error("Metadata does not contain jwks_uri");
            }

            return utility.getJson(metadata.jwks_uri, null, settings.httpSettings).then(function (jwks) {
                settings.jwks = jwks;
                return getKeyAsync(jwks);
            }, function (err) {
                return error("Failed to load signing keys (" + err.message + ")");
            });
        });
    },

    loadUserProfile: function (access_token) {
        utility.log("OidcClient.loadUserProfile");
        var self = this;

        return self.loadMetadataAsync().then(function (metadata) {

            if (!metadata.userinfo_endpoint) {
                return promise.reject(Error("Metadata does not contain userinfo_endpoint"));
            }

            return utility.getJson(metadata.userinfo_endpoint, access_token, self._settings.httpSettings);
        });
    },

    loadAuthorizationEndpoint: function () {
        utility.log("OidcClient.loadAuthorizationEndpoint");
        var self = this;

        if (self._settings.authorization_endpoint) {
            return promise.resolve(self._settings.authorization_endpoint);
        }

        if (!self._settings.authority) {
            return error("No authorization_endpoint configured");
        }

        return self.loadMetadataAsync().then(function (metadata) {

            if (!metadata || !metadata.authorization_endpoint) {
                var errorMessage = "Metadata does not contain authorization_endpoint";
                return error(errorMessage);
            }

            return metadata.authorization_endpoint;
        }).catch(function (error) {
            return error(error);
        });
    },

    createTokenRequestAsync: function () {
        utility.log("OidcClient.createTokenRequestAsync");

        var self = this;
        var settings = self._settings;

        return self.loadAuthorizationEndpoint().then(function (authorization_endpoint) {

            var state = utility.rand();
            var url = authorization_endpoint + "?state=" + encodeURIComponent(state);

            var nonce = null;

            if (self.isOidc()) {
                nonce = utility.rand();
                url += "&nonce=" + encodeURIComponent(nonce);
            }

            var required = ["client_id", "redirect_uri", "response_type", "scope"];
            required.forEach(function (key) {
                var value = settings[key];
                if (value) {
                    url += "&" + key + "=" + encodeURIComponent(value);
                }
            });

            var optional = ["prompt", "display", "max_age", "ui_locales", "id_token_hint", "login_hint", "acr_values", "response_mode"];
            optional.forEach(function (key) {
                var value = settings[key];
                if (value) {
                    url += "&" + key + "=" + encodeURIComponent(value);
                }
            });

            var request_state = {
                oidc: self.isOidc(),
                oauth: self.isOauth(),
                state: state
            };

            if (nonce) {
                request_state.nonce = nonce;
            }

            settings.request_state_store.set(settings.request_state_key, JSON.stringify(request_state));

            return {
                request_state: request_state,
                url: url
            };
        }, function (error) {
            return error(error);;
        });
    },

    createLogoutRequestAsync: function (id_token_hint) {
        utility.log("OidcClient.createLogoutRequestAsync");
        var self = this;
        var settings = self._settings;

        return self.loadMetadataAsync().then(function (metadata) {
            if (!metadata.end_session_endpoint) {
                return error("No end_session_endpoint in metadata");
            }

            var url = metadata.end_session_endpoint;
            if (id_token_hint && settings.post_logout_redirect_uri) {
                url += "?post_logout_redirect_uri=" + encodeURIComponent(settings.post_logout_redirect_uri);
                url += "&id_token_hint=" + encodeURIComponent(id_token_hint);
            }
            return url;
        });
    },

    validateIdTokenAsync: function (id_token, nonce, access_token) {
        utility.log("OidcClient.validateIdTokenAsync");

        var self = this;
        var settings = self._settings;

        return self.loadX509SigningKeyAsync().then(function (cert) {

            var jws = new r.jws.JWS();
            if (jws.verifyJWSByPemX509Cert(id_token, cert)) {
                var id_token_contents = JSON.parse(jws.parsedJWS.payloadS);

                if (nonce !== id_token_contents.nonce) {
                    return error("Invalid nonce");
                }

                return self.loadMetadataAsync().then(function (metadata) {

                    if (id_token_contents.iss !== metadata.issuer) {
                        return error("Invalid issuer");
                    }

                    if (id_token_contents.aud !== settings.client_id) {
                        return error("Invalid audience");
                    }

                    var now = Math.round(Date.now() / 1000);

                    // accept tokens issues up to 5 mins ago
                    var diff = now - id_token_contents.iat;
                    if (diff > (5 * 60)) {
                        return error("Token issued too long ago");
                    }

                    if (id_token_contents.exp < now) {
                        return error("Token expired");
                    }

                    if (access_token && settings.load_user_profile) {
                        // if we have an access token, then call user info endpoint
                        return self.loadUserProfile(access_token, id_token_contents).then(function (profile) {
                            if (profile.statusCode) {
                                // profile is an http response, not a profile response
                                return utility.copy(id_token_contents);
                            } else {
                                return utility.copy(profile, id_token_contents);
                            }

                        });
                    }
                    else {
                        // no access token, so we have all our claims
                        return id_token_contents;
                    }

                });
            }
            else {
                return error("JWT failed to validate");
            }
        });
    },

    validateAccessTokenAsync: function (id_token_contents, access_token) {
        utility.log("OidcClient.validateAccessTokenAsync");
        var self = this;

        if (!id_token_contents.at_hash) {
            return error("No at_hash in id_token");
        }

        var hash = r.crypto.Util.sha256(access_token);
        var left = hash.substr(0, hash.length / 2);
        var left_b64u = r.hextob64u(left);

        if (left_b64u !== id_token_contents.at_hash) {
            return error("at_hash failed to validate");
        }

        return promise.resolve();
    },

    validateIdTokenAndAccessTokenAsync: function (id_token, nonce, access_token) {
        utility.log("OidcClient.validateIdTokenAndAccessTokenAsync");

        var self = this;

        return self.validateIdTokenAsync(id_token, nonce, access_token).then(function (id_token_contents) {

            return self.validateAccessTokenAsync(id_token_contents, access_token).then(function () {

                return id_token_contents;

            });

        });
    },

    processResponseAsync: function (result, requestState) {
        utility.log("OidcClient.processResponseAsync");

        var self = this;
        var settings = self._settings;

        var request_state = requestState;

        if (!request_state) {
            request_state = settings.request_state_store.get(settings.request_state_key);
            settings.request_state_store.set(settings.request_state_key);
        }

        if (!request_state) {
            return error("No request state loaded");
        }

        request_state = JSON.parse(request_state);
        if (!request_state) {
            return error("No request state loaded");
        }

        if (!request_state.state) {
            return error("No state loaded");
        }

        if (!result) {
            return error("No OIDC response");
        }

        if (result.error) {
            return error(result.error);
        }

        if (result.state !== request_state.state) {
            return error("Invalid state");
        }

        if (request_state.oidc) {
            if (!result.id_token) {
                return error("No identity token");
            }

            if (!request_state.nonce) {
                return error("No nonce loaded");
            }
        }

        if (request_state.oauth) {
            if (!result.access_token) {
                return error("No access token");
            }

            if (!result.token_type || result.token_type.toLowerCase() !== "bearer") {
                return error("Invalid token type");
            }

            if (!result.expires_in) {
                return error("No token expiration");
            }
        }

        var localPromise = promise.resolve();
        if (request_state.oidc && request_state.oauth) {
            localPromise = self.validateIdTokenAndAccessTokenAsync(result.id_token, request_state.nonce, result.access_token);
        }
        else if (request_state.oidc) {
            localPromise = self.validateIdTokenAsync(result.id_token, request_state.nonce);
        }

        return localPromise.then(function (profile) {
            if (profile && settings.filter_protocol_claims) {
                var remove = ["nonce", "at_hash", "iat", "nbf", "exp", "aud", "iss", "idp"];
                remove.forEach(function (key) {
                    delete profile[key];
                });
            }

            return {
                profile: profile,
                id_token: result.id_token,
                access_token: result.access_token,
                expires_in: result.expires_in,
                scope: result.scope,
                session_state: result.session_state
            };
        });
    },

    mergeRequestOptions: function (req, options) {

        var self = this;
        var config = self._settings;

        function originalURL(req) {
            var headers = req.headers;
            var protocol = (req.connection.encrypted || req.headers['x-forwarded-proto'] == 'https') ? 'https' : 'http';
            var host = headers.host;
            var path = req.url || '';

            return protocol + '://' + host + path;
        }

        var callbackURL = options.callbackURL || config.callbackURL;
        if (callbackURL) {
            var parsed = url.parse(callbackURL);
            if (!parsed.protocol) {
                // The callback URL is relative, resolve a fully qualified URL from the
                // URL of the originating request.
                callbackURL = url.resolve(originalURL(req), callbackURL);
            }
        }

        var params = config;

        params.redirect_uri = callbackURL;

        if (options.response_mode || config.response_mode) {
            params.response_mode = options.response_mode || config.response_mode;
        }

        params.response_type = options.response_type || config.response_type;

        if (options.prompt) {
            params.prompt = options.prompt;
        }
        if (options.display) {
            params.display = options.display;
        }
        if (options.login_hint) {
            params.login_hint = options.login_hint;
        }
        if (options.accessType) {
            params.access_type = options.accessType;
        }
        if (options.openidRealm) {
            params.openid.realm = options.openidRealm;
        }
        if (options.hd) {
            params.hd = options.hd;
        }

        if (options.acr_values) {
            params.acr_values = options.acr_values;
        }

        var scope = options.scope || config.scope;
        if (Array.isArray(scope)) { scope = scope.join(config.scopeSeparator); }
        if (scope) {
            params.scope = 'openid' + config.scopeSeparator + scope;
        } else {
            params.scope = 'openid';
        }
  
        utility.log(params);
      
        self._settings = params;
    }
};

module.exports = OidcClient;