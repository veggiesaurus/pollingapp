var express = require("express");
var http = require('http');
var path = require('path');
var crypto = require('crypto');
var shortId = require('shortid');
var configs = require('./secrets.json');
var favicon = require('serve-favicon');
var utils = require('./utils');
var mongo = require('mongodb').MongoClient, assert = require('assert');
var dbURL = process.env.DB_URI || 'mongodb://localhost:27017/polling';
var dbCollection = 'polls';

var app = express();
var server = http.Server(app);
var io = require('socket.io')(server);
var sassMiddleware = require('node-sass-middleware');

var port=process.env.PORT || 80;

var socketPort=process.env.SOCKET_PORT || 3701;

var uuidCounter=1040;
var mapPolls = {};
var mapPollsDB = {};
var mapClients={};
var mapTimers = {};
var mapTimersDB={};
var mapResults={};
var mapSalts={};
				 
app.set('views', __dirname + '/views');
app.set('view engine', "jade");
app.engine('jade', require('jade').__express);
app.set('view options', { pretty: true });
app.use(express.static(__dirname + '/public'));
app.use(favicon(__dirname + '/public/images/favicon.png'));

io.set('transports', ['websocket',                       
                      'htmlfile', 
                      'xhr-polling', 
                      'jsonp-polling', 
                      'polling']);

io.listen(socketPort);

//sass config
app.use(sassMiddleware({
    /* Options */
    src: path.join(__dirname, 'sass'),
    dest: path.join(__dirname, 'public/css'),
    debug: false,
    outputStyle: 'compressed',
    response: true,
    prefix: '/css'
}));


//database for metrics
mongo.connect(dbURL, function (err, db) {
    assert.equal(null, err);
    console.log("Connected correctly to server");
    createIndices(db);
      
    require('./routes/redirects')(app);
    require('./routes/lecturer')(app, socketPort);
    require('./routes/student')(app, socketPort);
    require('./routes/metrics')(app, socketPort);
    
    app.get("/", function(req, res){
	    res.render("home");
    });
    
    io.sockets.on('connection', function (socket) 
    {
	    mapSalts[socket.id]=Math.floor((Math.random()*2000000)+1);
	    socket.emit('connectionSuccess', {salt:mapSalts[socket.id]});
	    //callbacks	
	    socket.on('courseCode', function (data) {onCourseCodeProvided(socket, data);});
        socket.on('auth', function (data) { onAuth(socket, data); });
	    socket.on('authMetrics', function (data){onAuthMetrics(socket,data);});		
	    socket.on('newPoll', function (data){addNewPoll(socket, data);});	
	    socket.on('pollSubmission', function (data){onPollSubmission(socket, data);});	
    });

    function onCourseCodeProvided(socket, data)
    {
	    //check for valid course code
	    if (data.courseCode)
	    {		
		    var courseCode=data.courseCode.toUpperCase();		
		    var uuid=data.uuid;
		    if (!isValidUUID(uuid))
			    uuid=shortId.generate();
            
            socket.join(courseCode);
		    socket.emit('joinedRoom', {roomName:courseCode, uuid: uuid, success: true});
		    //check if there is a current poll and the client hasn't already responsed to it
		    if (mapPolls[courseCode] && !mapPolls[courseCode].submittedClients[uuid])
			    socket.emit('pushNewPoll', {pollName: mapPolls[courseCode].pollName, numOptions:mapPolls[courseCode].numOptions});
	    }
    }

    function onAuth(socket, data)
    {			
	    var deptPasswordMD5=getPasswordForDept(data.dept);
	    var unhashedSalt=deptPasswordMD5+mapSalts[socket.id];
	    var saltedHash=crypto.createHash('md5').update(unhashedSalt).digest("hex");
	    if (deptPasswordMD5 && data.passwordMD5==saltedHash)
	    {
		    data.courseCode=data.courseCode.toUpperCase();
		    console.log("Lecturer has authenticated and been placed in room: "+data.courseCode+"_admin");
		    socket.join(data.courseCode+"_admin");
		    socket.emit('authComplete', {courseCode:data.courseCode, success: true});
	    }
	    else
	    {
		    socket.emit('authComplete', {courseCode:data.courseCode, success: false});
	    }
    }

    function addNewPoll(socket, data)
    {	
	    if (data.dept && data.courseCode)
		    data.courseCode=data.courseCode.toUpperCase();
	    else
	    {
		    socket.emit('pushedNewPoll', {pollName: data.pollName, success: false});
		    return;
	    };
	    var deptPasswordMD5=getPasswordForDept(data.dept);
	    var saltedHash=crypto.createHash('md5').update(deptPasswordMD5+mapSalts[socket.id]).digest("hex");
	    if(deptPasswordMD5 && data.passwordMD5==saltedHash && data.pollName && data.courseCode)
	    {
	
		    //in case the socket has been disconnected since last time, put the lecturer back in the right room
		    data.courseCode=data.courseCode.toUpperCase();
		    socket.join(data.courseCode+"_admin");
		
		    //emit poll to everyone else
		    console.log(data.courseCode+": Pushing new poll to students: "+data.pollName);
		    mapPolls[data.courseCode]={pollName: data.pollName, numOptions:data.numOptions, submittedClients:{}};
		    io.sockets.in(data.courseCode).emit('pushNewPoll', {pollName: data.pollName, numOptions:data.numOptions});
		
		    //emit success to the lecturer
		    socket.emit('pushedNewPoll', {pollName: data.pollName, success: true});

		    //results
		    var len=parseInt(data.numOptions);
		    var results=new Array(len);
		    for (var i=0;i<results.length;i++)
			    results[i]=0;
		    mapResults[data.courseCode]={pollName:data.pollName, results:results};
            
            //clear callback timers for sockets and DB
            if (mapTimers[data.courseCode])
                clearTimeout(mapTimers[data.courseCode]);
            if (mapTimersDB[data.courseCode])
                clearTimeout(mapTimersDB[data.courseCode]);

            //add entry to database
            var roomId = -1;
            var courseCode = data.courseCode;
            //get roomId and courseCode from concatenated course code
            var splitCourseCode = data.courseCode.split("/");
            if (splitCourseCode.length > 1) {
                roomId = splitCourseCode[1];
                courseCode = splitCourseCode[0];
            }
            
            insertPoll(db, data.dept, courseCode, roomId, data.pollName, data.numOptions, function (err, pollId) {
                if (err)
                    console.log(err);
                else {
                    mapPollsDB[data.courseCode] = pollId;
                    mapTimersDB[data.courseCode] = setInterval(updateDB = function () {
                        //database update
                        updatePoll(db, mapPollsDB[data.courseCode], mapResults[data.courseCode].results, function (err, data) { 
                            if (err)
                                console.log(err);
                        });
                    }, 5000);
                }
            });
          
		    mapTimers[data.courseCode]=setInterval(pushResults=function()
		    {	
                io.sockets.in(data.courseCode + "_admin").emit('pushResults', mapResults[data.courseCode]);               
		    }, 2000);
		    pushResults();
	    }
	    else
	    {
		    //emit failure to lecturer
		    socket.emit('pushedNewPoll', {pollName: data.pollName, success: false});
	    }
    }
    
    function onPollSubmission(socket, data) {
        if (data.courseCode)
            data.courseCode = data.courseCode.toUpperCase();
        
        if (!data.courseCode || !data.pollName || !data.submission) {
            console.log("Invalid poll reply: missing data");
            socket.emit('pollSubmissionComplete', { pollName: data.pollName, success: false, reason: 'missingData' });
        }
        else if (!mapPolls[data.courseCode] || data.pollName != mapPolls[data.courseCode].pollName) {
            console.log("Invalid poll reply: poll is not available");
            socket.emit('pollSubmissionComplete', { pollName: data.pollName, success: false, reason: 'invalidPoll' });
        }
        else if (data.submission < 1 || data.submission > mapResults[data.courseCode].results.length + 1) {
            console.log("Invalid poll reply: submission is out of range");
            socket.emit('pollSubmissionComplete', { pollName: data.pollName, success: false, reason: 'outOfRange' });
        }
        else if (!data.uuid || !isValidUUID(data.uuid) || mapPolls[data.courseCode].submittedClients[data.uuid]) {
            console.log("Invalid poll reply: client has already submitted poll response");
            socket.emit('pollSubmissionComplete', { pollName: data.pollName, success: false, reason: 'duplicate' });
        }
        else {
            //have to minus 1 because poll options are 1->N and array is 0->N-1
            mapResults[data.courseCode].results[data.submission - 1]++;
            //record IP address of those who submitted
            mapPolls[data.courseCode].submittedClients[data.uuid] = true;
            //emit success to the student
            socket.emit('pollSubmissionComplete', { pollName: data.pollName, success: true });
        }
    }
    
    function onAuthMetrics(socket, data) {
        var deptPasswordMD5 = getPasswordForDept(data.dept);
        var unhashedSalt = deptPasswordMD5 + mapSalts[socket.id];
        var saltedHash = crypto.createHash('md5').update(unhashedSalt).digest("hex");
        if (deptPasswordMD5 && data.passwordMD5 == saltedHash) {
            data.courseCode = data.courseCode.toUpperCase();            
            console.log("Observer has authenticated for metrics (dept: " + data.dept?data.dept:'*' + ", course: " + data.courseCode?data.courseCode:'*');
            
            var roomId = '';
            var courseCode = data.courseCode;
            //get roomId and courseCode from concatenated course code
            var splitCourseCode = data.courseCode.split("/");
            if (splitCourseCode.length > 1) {
                roomId = splitCourseCode[1];
                courseCode = splitCourseCode[0];
            }

            socket.emit('authCompleteMetrics', { courseCode: data.courseCode, success: true });
            getPolls(db, data.dept, courseCode, roomId, function (err, polls) {
                if (err) {
                    console.log(err);
                    socket.emit('pushedMetrics', { err: err });
                }
                else {
                    //create histograms and push to client
                    var dayOfWeekHist = [0, 0, 0, 0, 0, 0, 0];
                    var dayOfWeekResponseHist = [0, 0, 0, 0, 0, 0, 0];
                    var monthOfYearHist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                    var optionsHist = [0, 0, 0, 0, 0, 0, 0];
                    var deptHist = {};
                    var courseHist = {};
                    var roomHist = {};
                    var lecturePeriodHist = [0, 0, 0, 0, 0, 0, 0, 0];
                    var lecturePeriodResponseHist = [0, 0, 0, 0, 0, 0, 0, 0];
                    for (var i = 0; i < polls.length; i++) {
                        var pollResponses = polls[i].numResponses;
                        //fill timing hists
                        var pollTimestamp = polls[i]._id.getTimestamp();
                        var pollDay = pollTimestamp.getDay();
                        var pollMonth = pollTimestamp.getMonth();
                        //simplifies comparisons considerably
                        var pollTime = pollTimestamp.getHours()+0.01*pollTimestamp.getMinutes();
                        var pollPeriod;
                        if (pollTime<7.30 || pollTime > 15.45)
                            pollPeriod = -1;
                        else if (pollTime<=8.45)
                            pollPeriod=0;
                        else if (pollTime<=9.45)
                            pollPeriod=1;
                        else if (pollTime<=10.45)
                            pollPeriod=2;
                        else if (pollTime<=11.45)
                            pollPeriod=3;
                        else if (pollTime<=12.45)
                            pollPeriod=4;
                        else if (pollTime<=13.45)
                            pollPeriod=5;
                        else if (pollTime<=14.45)
                            pollPeriod=6;
                        else if (pollTime<=15.45)
                            pollPeriod=7;
                        
                        if (pollPeriod>=0){
                            lecturePeriodHist[pollPeriod]++;
                            lecturePeriodResponseHist[pollPeriod]+=pollResponses;
                        }
                        
                        dayOfWeekHist[pollDay]++;
                        dayOfWeekResponseHist[pollDay]+=pollResponses;
                        monthOfYearHist[pollMonth]++;
                        //fill options and response hists
                        
                        //init map elements if they're null (course, dept & room hists)
                        if (!deptHist[polls[i].dept])
                            deptHist[polls[i].dept] = 0;
                        if (!courseHist[polls[i].courseCode])
                            courseHist[polls[i].courseCode] = 0;
                        if (!roomHist[polls[i].roomId])
                            roomHist[polls[i].roomId] = 0;
                        //increment maps
                        deptHist[polls[i].dept]++;
                        courseHist[polls[i].courseCode]++;
                        roomHist[polls[i].roomId]++;
                    }
                    for (var i in lecturePeriodHist){
                        if (lecturePeriodHist[i]>0)
                            lecturePeriodResponseHist[i]/=lecturePeriodHist[i];
                    }
                    for (var i in dayOfWeekHist){
                        if (dayOfWeekHist[i]>0)
                            dayOfWeekResponseHist[i]/=dayOfWeekHist[i];
                    }
                    //push to client                
                    socket.emit('pushedMetrics', { dept: data.dept, courseCode: data.courseCode, lecturePeriodHist: lecturePeriodHist, lecturePeriodResponseHist: lecturePeriodResponseHist, dayOfWeekHist: dayOfWeekHist, dayOfWeekResponseHist: dayOfWeekResponseHist, monthOfYearHist: monthOfYearHist, deptHist: deptHist, courseHist: courseHist, roomHist: roomHist });
                }
            });
            
        }
        else {
            console.log("Authentication error");
            socket.emit('authCompleteMetrics', { courseCode: data.courseCode, success: false });
        }
    }

	if (process.env.LISTEN_HOST)
		server.listen(port, process.env.LISTEN_HOST, function(){
		console.log('Listening on port '+port+' and address '+process.env.LISTEN_HOST);
	});
	else
		server.listen(port, function(){
		console.log('Listening on port '+port);
	});
});



function isValidUUID(uuid) {
    if (uuid === null || uuid == undefined || uuid == "undefined" || uuid.length < 6 || uuid.length > 12)
        return false;
    else
        return true;
}

function getPasswordForDept(dept) {
    if (dept) {
        var requestedExtension = dept.toUpperCase();
        for (i = 0; i < configs.departments.length; i++) {
            if (requestedExtension == configs.departments[i].extension.toUpperCase())
                return configs.departments[i].passwordMD5;
        }
    }
    else
        return configs.metricsPasswordMD5;
}

//
//Database functions
//

//Util
function createIndices(db) {
    var collection = db.collection(dbCollection);
    collection.createIndex({ dept: 1, courseCode: 1, roomId: 1 });   
}

//Write
//

function insertPoll(db, dept, courseCode, roomId, pollName, numOptions, done) {
    if (!db)
        return done({ name: 'DB Error', message: 'The connection to the database has been lost.' });
    var collection = db.collection(dbCollection);
    if (!collection)
        return done({ name: 'DB Error', message: 'The database collection is missing or invalid.' });
    collection.insert({ dept: dept.toLowerCase(), courseCode: courseCode.toLowerCase(), roomId: roomId, pollName: pollName, numOptions: numOptions, numResponses: 0, entries: new Array(numOptions) }, function (err, result) {
        if (err)
            done(err);
        else {
            done(null, result.ops[0]._id);
        }
    });    
}

function updatePoll(db, pollId, entries, done) {
    var numResponses = 0;
    for (var i = 0; i < entries.length; i++)
        numResponses += entries[i];
    if (!db)
        return done({ name: 'DB Error', message: 'The connection to the database has been lost.' });
    var collection = db.collection(dbCollection);
    if (!collection)
        return done({ name: 'DB Error', message: 'The database collection is missing or invalid.' });
    collection.updateOne({ _id: pollId }, { $set: { numResponses: numResponses, entries: entries } }, function (err, result) {
        if (err)
            done(err);
        else
            done(null, result);
    });    
}

//Query
//

function getPolls(db, dept, courseCode, roomId, done) {
    var query = {};
    if (dept)
        query.dept = dept.toLowerCase();
    if (courseCode)
        query.courseCode = courseCode.toLowerCase();
    if (roomId)
        query.roomId = roomId;
    var collection = db.collection(dbCollection);
    collection.find(query).toArray(function (err, result) {
        if (err)
            done(err);
        else
            done(null, result);
    });
}