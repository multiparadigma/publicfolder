var myProductName = "publicFolder", myVersion = "0.4.10";   

/*  The MIT License (MIT)
	Copyright (c) 2014-2017 Dave Winer
	
	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:
	
	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.
	
	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
	*/

exports.start = startup; 
exports.getConfig = function () {
	return (config);
	}
exports.setFolders = setFolders;

const chokidar = require ("chokidar");
const utils = require ("daveutils");
const s3 = require ("daves3");
const fs = require ("fs");
const AWS = require ("aws-sdk");
const filesystem = require ("davefilesystem");
const davehttp = require ("davehttp");

let config = {
	watchFolder: "watch/",
	s3FolderPath: undefined,
	urlS3Folder: undefined,
	
	httpPort: 1500,
	flHttpEnabled: true,
	
	logFname: "stats/log.json",
	fileStatsFname: "stats/localfiles.json",
	s3FileStatsFname: "stats/s3files.json",
	queueFname: "stats/queue.json",
	flWriteQueue: true,
	maxLogLength: 500,
	maxConcurrentThreads: 3,
	maxSizeForBlockUpload: 1024 * 1024 * 5, //5MB
	
	addToLogCallback: function (theLogItem) {
		}
	};
const fnameConfig = "config.json";

var flConsoleMsgInLastMinute = false;
var myChokidarWatcher = undefined;

function consoleMsg (s) {
	flConsoleMsgInLastMinute = true;
	console.log (s);
	}
function dateGreater (d1, d2) {
	return (new Date (d1) > new Date (d2));
	}
function s3UploadBigFile (f, s3path, type, acl, callback) {
	
	let theStream = fs.createReadStream (f);
	let splitpath = s3.splitPath (s3path);
	
	if (acl === undefined) {
		acl = "public-read";
		}
	
	let myParams = {
		Bucket: splitpath.Bucket,
		Key: splitpath.Key,
		ContentType: type, 
		ACL: acl
		};
	
	let s3obj = new AWS.S3 ({params: myParams});
	s3obj.upload ({Body: theStream}, function (err, data) {
		if (err) {
			if (callback !== undefined) {
				callback (err);
				}
			}
		else {
			if (callback !== undefined) {
				callback (undefined, data);
				}
			}
		});
	}
function readConfig (f, config, callback) {
	utils.sureFilePath (f, function () {
		fs.readFile (f, function (err, data) {
			if (!err) {
				try {
					var jstruct = JSON.parse (data.toString ());
					for (var x in jstruct) {
						config [x] = jstruct [x];
						}
					}
				catch (err) {
					consoleMsg ("readConfig: err == " + err.message);
					}
				}
			if (callback !== undefined) {
				callback ();
				}
			});
		});
	}
function okToUpload (f) {
	let fname = utils.stringLastField (f, "/");
	if (utils.beginsWith (fname, ".")) { //invisible files are not uploaded
		return (false);
		}
	return (true);
	}
function okToReportUpload (relpath, callback) {
	s3.getObjectMetadata (config.s3FolderPath + relpath, function (s3Stats) {
		let localStats = fs.statSync (config.watchFolder + relpath);
		if (callback !== undefined) {
			let flMatch = s3Stats.ContentLength == localStats.size;
			callback (flMatch && (localStats.size != 0));
			}
		});
	}
function getFileSizeString (localpath) {
	let stats = fs.statSync (localpath);
	return (utils.gigabyteString (stats.size));
	}
function minutesMessage (when) {
	let now = new Date ();
	when = new Date (when);
	let secs = (now - when) / 1000;
	if (secs < 60) {
		return (secs + " secs");
		}
	else {
		let mins = secs / 60;
		return (utils.trimTrailing (mins.toFixed (3), "0") + " mins");
		}
	}
function setFolders (jstruct) {
	console.log ("setFolders: jstruct == " + utils.jsonStringify (jstruct));
	if (jstruct.watchFolder !== config.watchFolder) {
		config.watchFolder = jstruct.watchFolder;
		startChokidar ();
		}
	}

//log file
	var watchLog = {
		stats: {
			ctLogSaves: 0,
			whenLastLogSave: new Date (0),
			ctUploads: 0,
			whenLastUpload: new Date (0),
			ctBytesUploaded: 0,
			ctDeletes: 0,
			whenLastDelete: new Date (0),
			},
		actions: new Array ()
		}
	var flLogChanged = false;
	function writeLog (callback) {
		watchLog.stats.ctLogSaves++;
		watchLog.stats.whenLastLogSave = new Date ();
		utils.sureFilePath (config.logFname, function () {
			fs.writeFile (config.logFname, utils.jsonStringify (watchLog), function (err) {
				if (callback !== undefined) {
					callback ();
					}
				});
			});
		}
	function readLog (callback) {
		utils.sureFilePath (config.logFname, function () {
			fs.readFile (config.logFname, function (err, data) {
				if (err) {
					writeLog ();
					callback ();
					}
				else {
					try {
						var jstruct = JSON.parse (data);
						watchLog = jstruct;
						callback ();
						}
					catch (err) {
						consoleMsg ("readLog: err.messaage == " + err.messaage);
						callback ();
						}
					}
				});
			});
		}
	function addToLog (action, relpath, url, whenstart, size) {
		watchLog.actions.unshift ({
			action: action, 
			path: relpath,
			url: url,
			size: size,
			secs: utils.secondsSince (whenstart),
			when: whenstart
			});
		while (watchLog.actions.length > config.maxLogLength) {
			watchLog.actions.pop ();
			}
		switch (action) {
			case "upload":
				watchLog.stats.ctUploads++;
				watchLog.stats.whenLastUpload = whenstart;
				watchLog.stats.ctBytesUploaded += size;
				break;
			case "delete":
				watchLog.stats.ctDeletes++;
				watchLog.stats.whenLastDelete = whenstart;
				break;
			}
		flLogChanged = true;
		config.addToLogCallback (watchLog.actions [0]);
		}
	function emptyLog () {
		watchLog.actions = new Array ();
		writeLog ();
		}
//the queue
	let queue = new Array (), ctConcurrentThreads = 0, flQueueChanged = false;
	let uploadingNow = new Object (); //helps us keep from uploading a file twice
	
	function addToQueue (operation, path) {
		let fladd = true;
		if ((operation == "upload") && uploadingNow [path]) { //we're currently uploading the file
			fladd = false;
			}
		else {
			for (var i = 0; i < queue.length; i++) {
				if ((queue [i].op == operation) && (queue [i].what == path)) { //the exact operation is already queued
					fladd = false; 
					}
				}
			}
		if (fladd) {
			queue.push ({
				op: operation,
				what: path
				});
			flQueueChanged = true;
			}
		}
	function writeQueue (callback) {
		utils.sureFilePath (config.queueFname, function () {
			fs.writeFile (config.queueFname, utils.jsonStringify (queue), function (err) {
				if (callback !== undefined) {
					callback ();
					}
				});
			});
		}
	function queueStats () {
		let threads = "thread";
		if (ctConcurrentThreads !== 1) {
			threads += "s";
			}
		
		let items = "item";
		if (queue.length !== 1) {
			items += "s";
			}
		
		return (" " + ctConcurrentThreads + " " + threads + ", " + queue.length + " " + items + " in queue.");
		}
	function processQueue () {
		while ((queue.length > 0) && (ctConcurrentThreads < config.maxConcurrentThreads)) {
			let next = queue.shift ();
			flQueueChanged = true;
			function uploadFile (relpath) {
				let localpath = config.watchFolder + relpath;
				let s3path = config.s3FolderPath + relpath;
				function fileStillCopying (stats) {
					return (false);
					}
				if (uploadingNow [localpath] === undefined) {
					let stats = fs.statSync (localpath);
					if (fileStillCopying (stats)) { 
						consoleMsg ("uploadFile: putting \"" + localpath + "\" back on the queue.");
						queue.push (next);
						flQueueChanged = true;
						}
					else {
						uploadingNow [localpath] = true;
						ctConcurrentThreads++;
						let ext = utils.stringLastField (localpath, ".");
						let type = utils.httpExt2MIME (ext), whenstart = new Date ();
						if (stats.size <= config.maxSizeForBlockUpload) { //upload in one read, no streaming needed (small file)
							fs.readFile (localpath, function (err, filedata) {
								if (err) {
									consoleMsg ("error reading \"" + f + "\" == " + err.message);
									ctConcurrentThreads--;
									}
								else {
									s3.newObject (s3path, filedata, type, "public-read", function (err) {
										if (err) {
											consoleMsg ("uploadFile: " + s3path + ", err.message == " + err.message);
											}
										else {
											okToReportUpload (relpath, function (ok) { //if sizes don't match, don't report the copy
												if (ok) {
													let sizestring = getFileSizeString (localpath);
													consoleMsg ("uploadFile: " + relpath + ", " + minutesMessage (whenstart) + ", " + sizestring + ". " + queueStats ());
													addToLog ("upload", relpath, url, whenstart, filedata.length);
													}
												});
											}
										delete uploadingNow [localpath];
										ctConcurrentThreads--;
										});
									}
								});
							}
						else {
							s3UploadBigFile (localpath, s3path, type, "public-read", function (err, data) {
								if (err) {
									consoleMsg ("uploadFile: err.message == " + err.message); 
									}
								else {
									okToReportUpload (relpath, function (ok) { //if sizes don't match, don't report the copy
										if (ok) {
											let sizestring = getFileSizeString (localpath);
											consoleMsg ("uploadFile: " + relpath + ", " + minutesMessage (whenstart) + ", " + sizestring + ". " + queueStats ());
											addToLog ("upload", relpath, url, whenstart, stats.size);
											}
										});
									}
								delete uploadingNow [localpath];
								ctConcurrentThreads--;
								});
							}
						}
					}
				}
			function deleteFile (relpath) {
				let s3path = config.s3FolderPath + relpath;
				let whenstart = new Date ();
				ctConcurrentThreads++;
				s3.deleteObject (s3path, function (err) {
					ctConcurrentThreads--;
					consoleMsg ("deleteFile: " + s3path + ", " + utils.secondsSince (whenstart) + " secs.");
					addToLog ("delete", relpath, undefined, whenstart, undefined);
					});
				}
			let localpath = config.watchFolder + next.what;
			let s3path = config.s3FolderPath + next.what;
			let url = config.urlS3Folder + next.what;
			switch (next.op) {
				case "upload":
					uploadFile (next.what);
					break;
				case "delete":
					deleteFile (next.what);
					break;
				default: 
					break;
				}
			}
		}
//chokidar
	function startChokidar () {
		if (myChokidarWatcher !== undefined) { //the watchfolder changed -- 9/8/17 by DW
			myChokidarWatcher.close ();
			}
		myChokidarWatcher = chokidar.watch (config.watchFolder, {
			ignoreInitial: true,
			awaitWriteFinish: true
			});
		myChokidarWatcher.on ("all", function (event, f) {
			let relpath = utils.stringDelete (f, 1, config.watchFolder.length), whenstart = new Date ();
			switch (event) {
				case "add":
				case "change":
					if (okToUpload (f)) {
						addToQueue ("upload", relpath);
						}
					break;
				case "unlink": {
					addToQueue ("delete", relpath);
					break;
					}
				}
			});
		}
//non-chokidar scanning
	var s3FileStats, localFileStats;
	
	function getS3FileStats (s3path, callback) {
		if (s3path !== undefined) {
			let whenstart = new Date ();
			let splitpath = s3.splitPath (s3path);
			s3FileStats = {};
			s3.listObjects (s3path, function (obj) {
				if (obj.flLastObject !== undefined) {
					utils.sureFilePath (config.s3FileStatsFname, function () {
						fs.writeFile (config.s3FileStatsFname, utils.jsonStringify (s3FileStats), function (err) {
							if (callback !== undefined) {
								callback ();
								}
							});
						});
					}
				else {
					let key = utils.stringDelete (obj.Key, 1, splitpath.Key.length);
					s3FileStats [key] = {
						modified: new Date (obj.LastModified), 
						};
					}
				});
			}
		}
	function getLocalFilestats (watchFolder, callback) {
		if (watchFolder !== undefined) {
			function forEachFile (f) {
				if (okToUpload (f)) {
					let stats = fs.statSync (f);
					localFileStats [utils.stringDelete (f, 1, watchFolder.length)] = {
						accessed: stats.atime, //when the data was last read
						modified: stats.mtime, //when one of the stats was changed
						changed: stats.ctime, //this is the important one
						created: stats.birthtime
						};
					}
				}
			localFileStats = {};
			filesystem.recursivelyVisitFiles (watchFolder, forEachFile, function () {
				utils.sureFilePath (config.fileStatsFname, function () {
					fs.writeFile (config.fileStatsFname, utils.jsonStringify (localFileStats), function (err) {
						if (callback !== undefined) {
							callback ();
							}
						});
					});
				});
			}
		}
	function checkFileAndS3Stats () {
		if ((queue.length == 0) && (ctConcurrentThreads == 0)) {
			getLocalFilestats (config.watchFolder, function () {
				getS3FileStats (config.s3FolderPath, function () {
					for (var x in localFileStats) {
						if (s3FileStats [x] === undefined) {
							if (okToUpload (x)) {
								consoleMsg ("The file \"" + x + "\" is not present in the S3 folder.");
								addToQueue ("upload", x);
								}
							}
						else {
							if (dateGreater (localFileStats [x].modified, s3FileStats [x].modified)) {
								consoleMsg ("The local file \"" + x + "\" has been modified.");
								addToQueue ("upload", x);
								}
							}
						}
					for (var x in s3FileStats) {
						if (localFileStats [x] === undefined) {
							addToQueue ("delete", x);
							}
						}
					});
				});
			}
		}
//folder to outline
	function folderToOutline (folder) {
		function visitFolder (folder, subs) {
			let list = fs.readdirSync (folder);
			for (var i = 0; i < list.length; i++) {
				let fname = list [i], f = folder + fname;
				if (okToUpload (f)) {
					let stats = fs.statSync (f);
					let sub = {
						text: fname,
						size: stats.size,
						created: stats.birthtime,
						modified: stats.ctime 
						};
					subs.push (sub);
					if (stats.isDirectory ()) {
						sub.subs = [];
						visitFolder (f + "/", sub.subs);
						}
					}
				}
			}
		let theOutline = {
			subs: [
				]
			}
		visitFolder (folder, theOutline.subs);
		return (theOutline);
		}
//http server
	function startHttp () {
		if (config.flHttpEnabled) {
			let httpConfig = {
				port: config.httpPort
				};
			davehttp.start (httpConfig, function (theRequest) {
				function dataResponse (data) {
					theRequest.httpReturn (200, "application/json", utils.jsonStringify (data));
					}
				function errorResponse (error) {
					theRequest.httpReturn (500, "application/json", utils.jsonStringify (error));
					}
				function notFoundResponse () {
					theRequest.httpReturn (404, "text/plain", "Not found.");
					}
				switch (theRequest.lowerpath) {
					case "/":
						fs.readFile ("index.html", function (err, data) {
							if (err) {
								notFoundResponse ();
								}
							else {
								theRequest.httpReturn (200, "text/html", data);
								}
							});
						break;
					case "/log":
						dataResponse (watchLog);
						break;
					case "/queue":
						dataResponse (queue);
						break;
					case "/uploadingnow":
						dataResponse (uploadingNow);
						break;
					case "/localfiles":
						dataResponse (localFileStats);
						break;
					case "/localfilesoutline":
						dataResponse (folderToOutline (config.watchFolder));
						break;
					case "/s3files":
						dataResponse (s3FileStats);
						break;
					default:
						notFoundResponse ();
						break;
					}
				});
			}
		}

function everyMinute () {
	let addthis = ""
	if (flConsoleMsgInLastMinute) {
		flConsoleMsgInLastMinute = false;
		addthis = "\n";
		}
	console.log (addthis + myProductName + " v" + myVersion + ": " + new Date ().toLocaleTimeString () + "." + queueStats () + "\n");
	checkFileAndS3Stats ();
	}
function everySecond () {
	if (flLogChanged) {
		flLogChanged = false;
		writeLog ();
		}
	if (flQueueChanged) {
		if  (config.flWriteQueue) {
			writeQueue ();
			}
		flQueueChanged = false;
		}
	}
function everyQuarterSecond () {
	processQueue ();
	}

function startup (configParam, callback) {
	console.log ("\n" + myProductName + " v" + myVersion + "\n");
	if (configParam !== undefined) {
		for (x in configParam) {
			config [x] = configParam [x];
			}
		}
	readConfig (fnameConfig, config, function () {
		console.log ("config == " + utils.jsonStringify (config) + "\n");
		if (config.s3FolderPath === undefined) {
			console.log ("Can't start \"publicfolder\" because config.s3FolderPath is not defined.\n");
			return;
			}
		readLog (function () {
			startChokidar ();
			checkFileAndS3Stats ();
			startHttp ();
			setInterval (everyQuarterSecond, 250); 
			setInterval (everySecond, 1000); 
			utils.runAtTopOfMinute (function () {
				setInterval (everyMinute, 60000); 
				everyMinute ();
				});
			if (callback !== undefined) {
				callback ();
				}
			});
		});
	}
