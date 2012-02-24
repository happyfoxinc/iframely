(function(iframely) {

var _ = require('underscore');
var events = require('events');
var http = require('http');
var https = require('https');
var httpLink = require('http-link');
var sax = require('sax');
var stream = require('stream');
var url = require('url');
var util = require('util');

var NodeCache = require('node-cache');

var linksCache = new NodeCache();

var oembedsCache = new NodeCache();

/**
 * Fetches oembed links for the given page uri
 */
iframely.getOembedLinks = function(uri, callback) {
    var links = lookupStaticProviders(uri);
    if (links) {
        callback(null, links);
        
    } else {
        linksCache.get(uri, function(error, data) {
            if (!error && data && uri in data) {
                callback(null, data[uri]);
                
            } else {
                getPage(uri, function(res) {
                    if (res.statusCode == 200) {
                        var links = [];

                        var linkHeaders = res.headers.link;
                        if (linkHeaders) {
                            links = links.reduce(function(links, value) {
                                return links.concat(httpLink.parse(value).filter(isOembed));
                            }, []);

                            if (links.length) {
                                callback(null, links);
                                return;
                            }
                        }

                        var saxStream = sax.createStream(false);

                        var end = false;
                        saxStream.on('error', function(err) {
                            console.log('sax error', err);
                            callback(error);
                        });
                        saxStream.on('opentag', function(tag) {
                            if (tag.name === 'LINK' && isOembed(tag.attributes)) {
                                links.push(tag.attributes);
                            }
                        });
                        saxStream.on('closetag', function(name) {
                            if (name === 'HEAD') {
                                linksCache.set(uri, links, 300);
                                callback(null, links);
                                end = true;
                            }
                        });
                        saxStream.on('end', function() {
                            if (!end) {
                                callback(null, links);
                                end = true;
                            }
                        });

                        res.pipe(saxStream);

                    } else {
                        callback({error: true, code: res.statusCode});
                    }
                }, 3);
            }
        });
    }
};

/**
 * Fetches oembed for the given oembed uri
 */
iframely.getOembedByProvider = function(uri, options, callback) {
    var oembedUri = url.parse(uri);
    
    if (typeof options == 'function') {
        callback = options;
        options = {};
    }

    var params = [];
    if (options.maxwidth) params.push('maxwidth=' + options.maxwidth);
    if (options.maxheigth) params.push('maxheight=' + options.maxheigth);

    if (params.length) {
        oembedUri.path += (oembedUri.path.match('\\?')? '&': '?') + params.join('&');
    }
    
    var cacheKey = url.format(oembedUri);
    oembedsCache.get(cacheKey, function(error, data) {
        if (!error && data && cacheKey in data) {
            var oembedData = data[cacheKey];

            var res = new ProxyStream();
            res.oembedUrl = cacheKey;
            res.statusCode = 200;
            res.headers = oembedData.headers;
            callback(null, res);
            process.nextTick(function() {
                res.end(oembedData.data);
            });

        } else {
            oembedUri.headers = options.headers;

            getPage(oembedUri, function(res) {
                if (res.statusCode == 200) {
                    res.oembedUrl = cacheKey;
                    var headers = {};
                    for (var prop in res.headers) {
                        headers[prop] = res.headers[prop];
                    }
                    var oembedData = {
                        headers: headers,
                        data: ''
                    };
                    res.on('data', function(data) {
                        oembedData.data += data;
                    });
                    res.on('end', function() {
                        oembedsCache.set(cacheKey, oembedData, 3600);
                    });
                    
                    callback(null, res);
                    
                } else if (res.statusCode == 304) {
                    callback({error: 'not-modified'});
                    
                } else {
                    callback({error: 'not-found'});
                }
                
            }).on('error', function(error) {
                callback(error);
            });
        }
    });
};

/**
 * Fetches oembed for the given page uri
 */
iframely.getOembed = function(uri, options, callback) {
    if (typeof options == 'function') {
        callback = options;
        options = {};
    }

    iframely.getOembedLinks(uri, function(error, links) {
        if (error) {
            callback(error);

        } else if (links.length == 0) {
            callback({error: 'not-found'});

        } else {
            var format = options.format;

            var link = format && _.find(links, function(l) {return l.type.match(format);}) || links[0];

            iframely.getOembedByProvider(link.href, options, callback);
        }        
    });
};

function isOembed(link) {
    return link.type === 'application/json+oembed' || link.type === 'application/xml+oembed' || link.type === 'text/xml+oembed';
} 

function lookupStaticProviders(uri) {
    var providers = require('./providers.json');
    
    var protoMatch = uri.match(/^(https?:\/\/)/);
    uri = uri.substr(protoMatch[1].length);
    
    var links;
    for (var j = 0; j < providers.length; j++) {
        var p = providers[j];
        var match;
        for (var i = 0; i < p.templates.length; i++) {
            match = uri.match(p.templates[i]);
            if (match) break;
        }
        
        if (match) {
            links = p.links.map(function(l) {
                return {
                    href: l.href.replace('{part1}', match[1]),
                    rel: 'alternate',
                    type: l.type
                }
            });
            break;
        }
    }
    
    return links;
}

function getPage(uri, callback, maxRedirects) {
    var req = callback instanceof events.EventEmitter? callback: new events.EventEmitter();
    
    if (typeof callback === 'function') {
        req.on('response', callback);
    }
    
    var parsedUri
    if (typeof uri == 'string') {
        parsedUri = url.parse(uri);
        
    } else {
        parsedUri = uri;
    }
    
    var handler = uri.protocol === 'http:'? https: http;
    handler.get({
        host: parsedUri.hostname,
        port: parsedUri.port,
        path: parsedUri.path,
        headers: uri.headers
    }, function(res) {
        if (res.statusCode == 301 || res.statusCode == 302) {
            if (maxRedirects === 0) {
                req.emit('error', {error: 'max-redirects'});
                
            } else {
                var redirectUri = url.resolve(parsedUri, res.headers.location);
                redirectUri.headers = uri.headers;
                getPage(redirectUri, req, maxRedirects > 0? maxRedirects - 1: maxRedirects);
            }
            
        } else {
            req.emit('response', res);
        }
        
    }).on('error', function(error) {
        req.emit('error', error);
    });
    
    return req;
}

function ProxyStream() {
    this.readable = true;
}

util.inherits(ProxyStream, stream.Stream);

ProxyStream.prototype.write = function(data) {
    this.emit('data', data);
};

ProxyStream.prototype.end = function(data) {
    if (data)
        this.emit('data', data);
    this.emit('end');
};

ProxyStream.prototype.pause = function() {
    this.emit('pause');
};

ProxyStream.prototype.resume = function() {
    this.emit('resume');
};

})(exports);
