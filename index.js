var express = require("express");
var app = express();
var port = 3700;

//hard coded for now
var passwordMD5="098f6bcd4621d373cade4e832627b4f6";

app.set('views', __dirname + '/tpl');
app.set('view engine', "jade");
app.engine('jade', require('jade').__express);
app.use(express.static(__dirname + '/public'));

app.get("/", function(req, res){
	res.render("student");
});

app.get("/lecView", function(req, res){
	res.render("lecturer");
});

var io = require('socket.io').listen(app.listen(port));

//production settings
io.enable('browser client minification');  // send minified client
io.enable('browser client etag');          // apply etag caching logic based on version number
io.enable('browser client gzip');          // gzip the file
io.set('log level', 1);                    // reduce logging

// enable all transports (optional if you want flashsocket support, please note that some hosting
// providers do not allow you to create servers that listen on a port different than 80 or their
// default port)
io.set('transports', [
    'websocket'
  , 'flashsocket'
  , 'htmlfile'
  , 'xhr-polling'
  , 'jsonp-polling'
]);


io.sockets.on('connection', function (socket) 
{
	console.log("Client connected. Waiting for course code or auth");
	socket.emit('connectionSuccess');
	//wait for client to  tell us which course they're in, or...
	socket.on('courseCode', function (courseCode) 
	{
		console.log("Client has been placed in room: "+courseCode);
		socket.join(courseCode);
		socket.emit('joinedRoom', {roomName:courseCode, success: true});
	});
	//...authenticate as the lecturer
	socket.on('auth', function (data) 
	{	
		console.log("Lecturer has authenticated and been placed in room: "+data.courseCode+"_admin");
		socket.join(data.courseCode+"_admin");
		socket.emit('authComplete', {courseCode:data.courseCode, success: true});
	});	
		
	socket.on('newPoll', function (data) 
	{	
		console.log("Recieved new poll");
		if(data.passwordMD5==passwordMD5 && data.pollName && data.courseCode)
		{
			//emit poll to everyone else
			io.sockets.in(data.courseCode).emit('pushNewPoll', {pollName: data.pollName, numOptions:data.numOptions});
			//emit success to the lecturer
			socket.emit('pushedNewPoll', {pollName: data.pollName, success: true});
			console.log("Pushing new poll to students: "+data.pollName);
		}
		else
		{
			//emit failure to lecturer
			socket.emit('pushedNewPoll', {pollName: data.pollName, success: false});
			console.log("Failed to push poll: "+data.pollName);
		}
	});
});

console.log("Listening on port " + port);