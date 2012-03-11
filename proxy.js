/*
** Peteris Krumins (peter@catonmat.net)
** http://www.catonmat.net  --  good coders code, great reuse
**
** A simple proxy server written in node.js.
**
*/

var http = require('http'),
    https = require('https');
    util = require('util');
    fs   = require('fs'),
    config = require('./config').config,
    blacklist = [],
    iplist    = [],
    hostfilters = {};

//support functions

//decode host and port info from header
function decode_host(host){
    out={};
    host = host.split(':');
    out.host = host[0];
    out.port = host[1] || 80;
    return out;
}

//encode host field
function encode_host(host){
    return host.host+((host.port==80)?"":":"+host.port);
}

//config files watchers
fs.watchFile(config.black_list,    function(c,p) { update_blacklist(); });
fs.watchFile(config.allow_ip_list, function(c,p) { update_iplist(); });
fs.watchFile(config.host_filters,  function(c,p) { update_hostfilters(); });

//add a X-Forwarded-For header ?
config.add_proxy_header = (config.add_proxy_header !== undefined && config.add_proxy_header == true);

//config files loaders/updaters
function update_list(msg, file, mapf, collectorf) {
  fs.stat(file, function(err, stats) {
    if (!err) {
      util.log(msg);
      fs.readFile(file, function(err, data) {
        collectorf(data.toString().split("\n")
                   .filter(function(rx){return rx.length;})
                   .map(mapf));
      });
    }
    else {
      util.log("File '" + file + "' was not found.");
      collectorf([]);
    }
  });
}

function update_hostfilters(){
    file = config.host_filters;
    fs.stat(file, function(err, stats) {
    if (!err) {
      util.log("Updating host filter");
      fs.readFile(file, function(err, data) {        
        hostfilters = JSON.parse(data.toString());
      });
    }
    else {
      util.log("File '" + file + "' was not found.");
      hostfilters = {};
    }
  });
}

function update_blacklist() {
  update_list(
    "Updating host black list.",
    config.black_list,
    function(rx){return RegExp(rx);},
    function(list){blacklist = list;}
  );
}

function update_iplist() {
  update_list(
    "Updating allowed ip list.",
    config.allow_ip_list,
    function(ip){return ip;},
    function(list){iplist = list;}
  );
}

//filtering rules
function ip_allowed(ip) {
  return iplist.some(function(ip_) { return ip==ip_; }) || iplist.length <1;
}

function host_allowed(host) {
  return !blacklist.some(function(host_) { return host_.test(host); });
}

//header decoding
function authenticate(request){
  token={
        "login":"anonymous",
        "pass":""
      };
  if (request.headers.authorization && request.headers.authorization.search('Basic ') === 0) {
    // fetch login and password
    basic = (new Buffer(request.headers.authorization.split(' ')[1], 'base64').toString());
    util.log("Authentication token received: "+basic);
    basic = basic.split(':');
    token.login = basic[0];
	token.pass = "";
	for(i=1;i<basic.length;i++){
		token.pass += basic[i];
	}
  }
  return token;
}

//proxying
//handle 2 rules:
//  * redirect (301)
//  * proxyto
//  * forcessl
function handle_proxy_rule(rule, target, token, ssl){
  //handle https enforcement
  if("forcessl" in rule && !ssl){
    target.action = "forcessl";
    return target;
  }
  
  //handle authorization
  if("validuser" in rule){
      if(!(token.login in rule.validuser) || (rule.validuser[token.login] != token.pass)){
         target.action = "authenticate";
         target.msg = rule.description || "";
         return target;
      }
  }
  
  //handle real actions
  if("redirect" in rule){
    target = decode_host(rule.redirect);
    target.action = "redirect";
  } else if("proxyto" in rule){
    target = decode_host(rule.proxyto);
    target.action = "proxyto";
  }
  return target;
}

function handle_proxy_route(host, token, ssl) {
    //extract target host and port
    action = decode_host(host);
    action.action="proxyto";//default action
    
    //try to find a matching rule
    if(action.host+':'+action.port in hostfilters){//rule of the form "foo.domain.tld:port"
      rule=hostfilters[action.host+':'+action.port];
      action=handle_proxy_rule(rule, action, token, ssl);
    }else if (action.host in hostfilters){//rule of the form "foo.domain.tld"
      rule=hostfilters[action.host];
      action=handle_proxy_rule(rule, action, token, ssl);
    }else if ("*:"+action.port in hostfilters){//rule of the form "*:port"
      rule=hostfilters['*:'+action.port];
      action=handle_proxy_rule(rule, action, token, ssl);
    }else if ("*" in hostfilters){//default rule "*"
      rule=hostfilters['*'];
      action=handle_proxy_rule(rule, action, token, ssl);
    }
    return action;
}

function prevent_loop(request, response){
  if(request.headers.proxy=="node.jtlebi"){//if request is already tooted => loop
    util.log("Loop detected");
    response.writeHead(500);
    response.write("Proxy loop !");
    response.end();
    return false;
  } else {//append a tattoo to it
    request.headers.proxy="node.jtlebi";
    return request;
  }
}

function action_authenticate(response, msg){
  response.writeHead(401,{
    'WWW-Authenticate': "Basic realm=\""+msg+"\""
  });
  response.end();
}

function action_deny(response, msg) {
  response.writeHead(403);
  response.write(msg);
  response.end();
}

function action_notfound(response, msg){
  response.writeHead(404);
  response.write(msg);
  response.end();
}

function action_redirect(response, host){
  util.log("Redirecting to " + host);
  response.writeHead(301,{
    'Location': "http://"+host
  });
  response.end();
}

function action_forcessl(response, host, url){
  util.log("Enforcing ssl on " + host + "/" + url);
  response.writeHead(301,{
    'Location': "https://"+host+url
  });
  response.end();
}

function action_proxy(response, request, host){
  util.log("Proxying to " + host);
  
  //detect HTTP version
  var legacy_http = request.httpVersionMajor == 1 && request.httpVersionMinor < 1 || request.httpVersionMajor < 1;
    
  //launch new request + insert proxy specific header
  var headers = request.headers;
  if(config.add_proxy_header){
    if(headers['X-Forwarded-For'] !== undefined){
      headers['X-Forwarded-For'] = request.connection.remoteAddress + ", " + headers['X-Forwarded-For'];
    }
    else{ 
      headers['X-Forwarded-For'] = request.connection.remoteAddress;
    }
  }
  var proxy = http.createClient(action.port, action.host);
  var proxy_request = proxy.request(request.method, request.url, request.headers);
  
  //deal with errors, timeout, con refused, ...
  proxy.on('error', function(err) {
    util.log(err.toString() + " on request to " + host);
    return action_notfound(response, "Requested resource ("+request.url+") is not accessible on host \""+host+"\"");
  });
  
  //proxies to FORWARD answer to real client
  proxy_request.addListener('response', function(proxy_response) {
    if(legacy_http && proxy_response.headers['transfer-encoding'] != undefined){
        console.log("legacy HTTP: "+request.httpVersion);
        
        //filter headers
        var headers = proxy_response.headers;
        delete proxy_response.headers['transfer-encoding'];        
        var buffer = "";
        
        //buffer answer
        proxy_response.addListener('data', function(chunk) {
          buffer += chunk;
        });
        proxy_response.addListener('end', function() {
          headers['Content-length'] = buffer.length;//cancel transfer encoding "chunked"
          response.writeHead(proxy_response.statusCode, headers);
          response.write(buffer, 'binary');
          response.end();
        });
    } else {
        //send headers as received
        response.writeHead(proxy_response.statusCode, proxy_response.headers);
        
        //easy data forward
        proxy_response.addListener('data', function(chunk) {
          response.write(chunk, 'binary');
        });
        proxy_response.addListener('end', function() {
          response.end();
        });
    }
  });

  //proxies to SEND request to real server
  request.addListener('data', function(chunk) {
    proxy_request.write(chunk, 'binary');
  });
  request.addListener('end', function() {
    proxy_request.end();
  });
}

//special security logging function
function security_log(request, response, msg){
  var ip = request.connection.remoteAddress;
  msg = "**SECURITY VIOLATION**, "+ip+","+(request.method||"!NO METHOD!")+" "+(request.headers.host||"!NO HOST!")+"=>"+(request.url||"!NO URL!")+","+msg;
  
  util.log(msg);
}

//security filter
// true if OK
// false to return immediatlely
function security_filter(request, response){
  //HTTP 1.1 protocol violation: no host, no method, no url
  if(request.headers.host === undefined ||
     request.method === undefined ||
     request.url === undefined){
    security_log(request, response, "Either host, method or url is poorly defined");
    return false;
  }
  return true;
}

//actual server loop
function server_cb(request, response) {
  //the *very* first action here is to handle security conditions
  //all related actions including logging are done by specialized functions
  //to ensure compartimentation
  if(!security_filter(request, response)) return;
  
  
  var ip = request.connection.remoteAddress;
  if (!ip_allowed(ip)) {
    msg = "IP " + ip + " is not allowed to use this proxy";
    action_deny(response, msg);
    security_log(request, response, msg);    
    return;
  }

  if (!host_allowed(request.url)) {
    msg = "Host " + request.url + " has been denied by proxy configuration";
    action_deny(response, msg);
    security_log(request, response, msg);    
    return;
  }
  
  //loop filter
  request = prevent_loop(request, response);
  if(!request){return;}
  
  util.log(ip + ": " + request.method + " " + request.headers.host + "=>" + request.url);
  
  //get authorization token
  authorization = authenticate(request);
  
  //calc new host info
  var action = handle_proxy_route(request.headers.host, authorization, request.ssl);
  host = encode_host(action);
  
  //handle action
  if(action.action == "redirect"){
    action_redirect(response, host);
  }else if(action.action == "proxyto"){
    action_proxy(response, request, host);
  } else if(action.action == "authenticate"){
    action_authenticate(response, action.msg);
  }
  else if(action.action == "forcessl"){
    action_forcessl(response, request.headers.host, request.url);
  }
}

function server_cb_builder(ssl){
  return function(req, res){
    req.ssl = ssl;
    server_cb(req, res);
  }
}

//last chance error handler
//it catch the exception preventing the application from crashing.
//I recommend to comment it in a development environment as it
//"Hides" very interesting bits of debugging informations.
process.on('uncaughtException', function (err) {
  console.log('LAST ERROR: Caught exception: ' + err);
  util.log(err.stack);
});

//startup + log
update_blacklist();
update_iplist();
update_hostfilters();

//http
config.listen.forEach(function(listen){
  util.log("Starting reverse proxy server on port '" + listen.ip+':'+listen.port);
  http.createServer(server_cb_builder(false)).listen(listen.port, listen.ip); 
});

//httpS
config.listen_ssl.forEach(function(listen){
  util.log("Starting *secure* reverse proxy server on port '" + listen.ip+':'+listen.port);
  var options = {
    cert: listen.cert,
    key: listen.key,
    ca: listen.ca
  }
  https.createServer(options, server_cb_builder(true)).listen(listen.port, listen.ip); 
});

