var fs = require('fs');
var net = require('net');
var crypto = require('crypto');

var async = require('async');
var bignum = require('bignum');
var multiHashing = require('multi-hashing');
var cnUtil = require('cryptonote-util');

// Must exactly be 8 hex chars, already lowercased before test
var noncePattern = new RegExp("^[0-9A-Fa-f]{8}$");

var threadId = '(Thread ' + process.env.forkId + ') ';

var logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
var utils = require('./utils.js');
Buffer.prototype.toByteArray = function () {
  return Array.prototype.slice.call(this, 0)
}

function isEmpty(o)
{
    for(var p in o)
	{ 
        if(o.hasOwnProperty(p))
		{
			return false;
		}
    }
	
    return true;
}
var log = function(severity, system, text, data){
    global.log(severity, system, threadId + text, data);
};

var cryptoNight = multiHashing['cryptonight'];
var convertBlockBlob;
if(config.coin === "lui")
{
	convertBlockBlob = function(blob) {
		return cnUtil.convert_blob_lui(blob);
	};
}
else
{
	convertBlockBlob = function(blob) {
		return cnUtil.convert_blob(blob);
	};
}
function cryptoNightFast(buf) {
    return cryptoNight(Buffer.concat([new Buffer([buf.length]), buf]), true);
}

function getFullScratchpad(callback) {
    apiInterfaces.rpcDaemon('getfullscratchpad', [], callback);
}

var scratchpad = new Buffer(0);
var scratchpadHeight = {block_id: '', height: 0};
/*getAddendums could be used for incremental scratchpad update, example:
*
* getAddendums(scratchpadHeight, function (error, data){
*   if(error)
*   {
*      log('error', 'Job Refresher', 'Failed to getAddendums, error: ' + error.message);
*      return;
*   }
*
*   if(data.status != 'OK')
*   {
*      log('error', 'Job Refresher', 'Failed to getAddendums, data.status: ' + data.status);
*      return;
*   }
*   //TODO: implement scratchapd incremental update
*   //data.addms -> array of addms
*
* });
*
* */

function getAddendums(current_hi, callback) {
    apiInterfaces.rpcDaemon('get_addendums', current_hi, callback);
}

function getFullScratchpad2(callback)
{
    log('debug', 'Job Refresher', 'Requesting scratchpad...');
    apiInterfaces.binRpcDaemon('/getfullscratchpad2', {}, function(er, buff)
    {
        if(er)
        {
            callback(er);
            return;
        }
        if(!buff.length)
        {
            callback({message:"Empty scratchpad returned from daemon"});
            return;
        }

        var bin_buffer = new Buffer(buff.slice(0, 4));
        var json_len = bin_buffer.readUInt32LE(0);
        var json_str_buff = buff.slice(4, 4 + json_len).toString();
        result = JSON.parse(json_str_buff);
        scratchpad = new Buffer(buff.slice(4 + json_len));
        scratchpadHeight.height = result.height;
        scratchpadHeight.block_id = result.block_id;
        callback(null);
        log('debug', 'Job Refresher', 'Json Prefix len: ' + json_len.toString() + ', scratchpadHeight:' + scratchpadHeight.height);
    });
}
function checkLogin(login, sendReply, callback)
{
	myerror = false;
	if(login.indexOf('@') === 0)
	{
		login = login.substr(1); 
		apiInterfaces.rpcDaemon('get_alias_details', {alias: login} , function (error, result)
		{
			if(error)
			{
				callback(error);
				return;
			}
			if ( result.status !== "OK" )
			{
					error = {message: 'alias invalid'};
					callback(error);
					return;


			}
			login = result.alias_details.address;
			if (addressBase58Prefix !== cnUtil.address_decode(new Buffer(login))){
				sendReply('invalid address used for login');
				error = {message: 'invalid address used for login'};
				callback(error);
				return;
			}
			callback(myerror, login);
		});
	}
	else
	{
		if (addressBase58Prefix !== cnUtil.address_decode(new Buffer(login))){
			sendReply('invalid address used for login');
			error = {message: 'invalid address used for login'};
			callback(error);
			return;
		}
		callback(myerror, login);
	}
	
}
function checkDonations(donations, sendReply, parsedAddresses, callback)
{
	var myerror = false;
	
	//returns.pop();
	if(donations.length  === 0)
	{
		callback(myerror,parsedAddresses);
		return;
	}
	var loginPair = donations.shift();
	if(loginPair[1] < config.poolServer.userDonations.minDonation)
	{
		error = {message: 'donation too low'};
		callback(error);
		return;
	}
	if(loginPair[1] > config.poolServer.userDonations.maxDonation)
	{
		error = {message: 'donation too high'};
		callback(error);
		return;
	}
	var login = loginPair[0];
	var loginOrig = loginPair[0];
	if(login.indexOf('@') === 0)
	{
		login = login.substr(1); 
	}
	
	apiInterfaces.rpcDaemon('get_alias_details', {alias: login} , function (error, result)
	{
		if(error)
		{
			if(error.code != 0)
			{
				callback(error);
				return;
			}
		}
		var result1;
		if(error && error.code == 0)
		{
			loginPair[0] = loginOrig;
			parsedAddresses.push(loginPair);
		}
		else if ( result.status !== "OK" )
		{
			error = {message: 'alias invalid'};
			loginPair[0] = loginOrig;
			parsedAddresses.push(loginPair);
		}
		else
		{
			loginPair[0] = result.alias_details.address;
			parsedAddresses.push(loginPair);
		}
		if(donations.length > 0)
		{
			checkDonations(donations, sendReply, parsedAddresses, function(myerror,result1)
			{
				if(myerror)
				{
					callback(myerror);
					return;
				}
				callback(myerror, result1);
			});
		}
		else
		{
		callback(myerror, parsedAddresses);
		return;
		}
	});
}
var diff1 = bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

var instanceId = crypto.randomBytes(4);

var validBlockTemplates = [];
var currentBlockTemplate;

var connectedMiners = {};

var bannedIPs = {};
var perIPStats = {};

var shareTrustEnabled = config.poolServer.shareTrust && config.poolServer.shareTrust.enabled;
var shareTrustStepFloat = shareTrustEnabled ? config.poolServer.shareTrust.stepDown / 100 : 0;
var shareTrustMinFloat = shareTrustEnabled ? config.poolServer.shareTrust.min / 100 : 0;


var banningEnabled = config.poolServer.banning && config.poolServer.banning.enabled;

var addressBase58Prefix = cnUtil.address_decode(new Buffer(config.poolServer.poolAddress));


setInterval(function(){
    var now = Date.now() / 1000 | 0;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if(!miner.noRetarget) {
            miner.retarget(now);
        }
    }
}, config.poolServer.varDiff.retargetTime * 1000);


/* Every 30 seconds clear out timed-out miners and old bans */
setInterval(function(){
    var now = Date.now();
    var timeout = config.poolServer.minerTimeout * 1000;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (now - miner.lastBeat > timeout){
            log('warn', logSystem, 'Miner timed out and disconnected %s@%s', [miner.login, miner.ip]);
            delete connectedMiners[minerId];
        }
    }

    if (banningEnabled){
        for (ip in bannedIPs){
            var banTime = bannedIPs[ip];
            if (now - banTime > config.poolServer.banning.time * 1000) {
                delete bannedIPs[ip];
                delete perIPStats[ip];
                log('info', logSystem, 'Ban dropped for %s', [ip]);
            }
        }
    }

}, 30000);


process.on('message', function(message) {
    switch (message.type) {
        case 'banIP':
            bannedIPs[message.ip] = Date.now();
            break;
    }
});


function IsBannedIp(ip){
    if (!banningEnabled || !bannedIPs[ip]) return false;

    var bannedTime = bannedIPs[ip];
    var bannedTimeAgo = Date.now() - bannedTime;
    var timeLeft = config.poolServer.banning.time * 1000 - bannedTimeAgo;
    if (timeLeft > 0){
        return true;
    }
    else {
        delete bannedIPs[ip];
        log('info', logSystem, 'Ban dropped for %s', [ip]);
        return false;
    }
}


function BlockTemplate(template){
    this.blob = template.blocktemplate_blob;
    this.difficulty = template.difficulty;
    this.height = template.height;
    this.reserveOffset = template.reserved_offset;
    this.buffer = new Buffer(this.blob, 'hex');
    instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3);
    this.extraNonce = 0;
}
BlockTemplate.prototype = {
    nextBlob: function(){
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
		return convertBlockBlob(this.buffer).toString('hex');
    }
};



function getBlockTemplate(callback)
{
    var alias_info = {};
    if(aliases_config && aliases_config.aliases_que && aliases_config.aliases_que.length > 0)
    {
        alias_info = aliases_config.aliases_que[0];
        //log('debug', logSystem, 'Set alias for blocktemplate: ' + alias_info.alias + ' -> ' + alias_info.address);
    }
	alias_info = current_alias;
    var obj_to_rpc = {reserve_size: 8, wallet_address: config.poolServer.poolAddress, alias_details: alias_info};
    //log('debug', logSystem, 'GetBlockTemplate request str:  ' + JSON.stringify(obj_to_rpc));
    apiInterfaces.rpcDaemon('getblocktemplate', obj_to_rpc, callback);
}



function jobRefresh(loop, callback){
    callback = callback || function(){};
    getBlockTemplate(function(error, result){
        if (loop)
            setTimeout(function(){
                jobRefresh(true);
            }, config.poolServer.blockRefreshInterval);
        if (error){
            log('error', logSystem, 'Error polling getblocktemplate %j', [error]);
            callback(false);
            return;
        }
        if (!currentBlockTemplate || result.height > currentBlockTemplate.height){
            log('info', logSystem, 'New block to mine at height %d w/ difficulty of %d', [result.height, result.difficulty]);
            processBlockTemplate(result);
        }
        callback(true);
    });
}


function exportScratchpad()
{
    if(!config.poolServer.scratchpadFilePath || config.poolServer.scratchpadFilePath === "")
        return;

    log('debug', logSystem, 'exportScratchpad...');

    apiInterfaces.rpcDaemon('store_scratchpad', {local_file_path: config.poolServer.scratchpadFilePath }, function (error, result)
    {
        if (error)
        {
            log('error', logSystem, 'Error storing scratchpad: ' + JSON.stringify(error));
        }
        else
        {
            log('debug', logSystem, 'Scratchpad saved success');
        }
        setTimeout(exportScratchpad, config.poolServer.scratchpadFileUpdateInterval);
    });
}


function processBlockTemplate(template){

    if (currentBlockTemplate)
        validBlockTemplates.push(currentBlockTemplate);

    if (validBlockTemplates.length > 3)
        validBlockTemplates.shift();

    currentBlockTemplate = new BlockTemplate(template);
		for (var minerId in connectedMiners){
        //XMR FIXME:
        var miner = connectedMiners[minerId];
        miner.pushMessage('job', miner.getJob());
				var job = miner.getJob();
				log('debug', 'processBlockTemplate', 'reply4, job: ' + JSON.stringify(job));
    }
		
}


var aliases_config = {};
var current_alias_index ={};
var current_alias = {};
function reloadAliasesQue()
{
	redisClient.lrange(
		config.coin + ':aliasrequests', 
		0 , 
		-1,
	function(err, result){
		var index;
		if(result.length === 0 || err)
		{
			current_alias = {};
			current_alias_index ={};
			return;
		}
		for (var i = 0;i < result.length;i++)
		{
			index = result[i];
			if(current_alias_index !== index )
			{
				redisClient.hgetall(result[i], function(err1, request){

					if(err1 || request === null)
					{
						log('warn', logSystem, 'alias request not found, perhaps it expired... removing: ', [index]);
						redisClient.lrem(config.coin + ':aliasrequests', -1, index,
						function(err, aresult){
							if(err)
							{
								log('error', logSystem, 'alias request not found, and could not remove from list %s' ,[err]);
							}
						});
						return;
					}
					index = config.coin + ':aliasrequest:' + request.alias;

					if(request.paid === '1')
					{
						log('warn', logSystem, 'aliasrequests result: ', [request, current_alias, current_alias_index]);
						current_alias_index =  index;
						current_alias = {
									alias: request.alias,
									address: request.address,
									tracking_key: '',
									comment: 'alias created at cncoin.farm'
								};
						log('info', logSystem, 'new alias request : %s ', [current_alias.alias]);
						return;
					}
				});
			}
			}
		}

		);
    setTimeout(reloadAliasesQue, 10000); //reload every 10 seconds
    return true;
}

(function init(){
	exportScratchpad();
    if(!reloadAliasesQue())
    {
        throw new Error('reloading aliases is failed');
    }

    jobRefresh(true, function(sucessful){
        if (!sucessful){
            log('error', logSystem, 'Could not start pool');
            return;
        }
        startPoolServerTcp(function(successful){

        });
    });
})();

var VarDiff = (function(){
    var variance = config.poolServer.varDiff.variancePercent / 100 * config.poolServer.varDiff.targetTime;
    return {
        variance: variance,
        bufferSize: config.poolServer.varDiff.retargetTime / config.poolServer.varDiff.targetTime * 4,
        tMin: config.poolServer.varDiff.targetTime - variance,
        tMax: config.poolServer.varDiff.targetTime + variance,
        maxJump: config.poolServer.varDiff.maxJump
    };
})();


function Miner(id, login, pass, ip, startingDiff, noRetarget, pushMessage, donationAddresses, donationPercentage){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.ip = ip;
    this.pushMessage = pushMessage;
    this.heartbeat();
    this.noRetarget = noRetarget;
    this.difficulty = startingDiff;
	this.donations = donationAddresses;
	this.donationPercentage = donationPercentage;
    this.validJobs = [];
    this.hi = {block_id: '', height: 0};
    this.addms = [];
	this.hasDonation = false;
	if (donationPercentage > 0)
	{
		this.hasDonation = true;
	}
	
    // Vardiff related variables
    this.shareTimeRing = utils.ringBuffer(16);
    this.lastShareTime = Date.now() / 1000 | 0;

    if (shareTrustEnabled) {
        this.trust = {
            threshold: config.poolServer.shareTrust.threshold,
            probability: 1,
            penalty: 0
        };
    }
}
Miner.prototype = {
    retarget: function(now){

        var options = config.poolServer.varDiff;

        var sinceLast = now - this.lastShareTime;
        var decreaser = sinceLast > VarDiff.tMax;

        var avg = this.shareTimeRing.avg(decreaser ? sinceLast : null);
        var newDiff;

        var direction;

        if (avg > VarDiff.tMax && this.difficulty > options.minDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff > options.minDiff ? newDiff : options.minDiff;
            direction = -1;
        }
        else if (avg < VarDiff.tMin && this.difficulty < options.maxDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff < options.maxDiff ? newDiff : options.maxDiff;
            direction = 1;
        }
        else{
            return;
        }

        if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > options.maxJump){
            var change = options.maxJump / 100 * this.difficulty * direction;
            newDiff = this.difficulty + change;
        }

        this.setNewDiff(newDiff);
        this.shareTimeRing.clear();
        if (decreaser) this.lastShareTime = now;
    },
    setNewDiff: function(newDiff){
        newDiff = Math.round(newDiff);
        if (this.difficulty === newDiff) return;
        log('info', logSystem, 'Retargetting difficulty %d to %d for %s', [this.difficulty, newDiff, this.login]);
        this.pendingDifficulty = newDiff;
            this.pushMessage('job', this.getJob());
    },
    heartbeat: function(){
        this.lastBeat = Date.now();
    },
    getTargetHex: function(){
        if (this.pendingDifficulty){
            this.lastDifficulty = this.difficulty;
            this.difficulty = this.pendingDifficulty;
            this.pendingDifficulty = null;
        }

        var padded = new Buffer(32);
        padded.fill(0);

        var diffBuff = diff1.div(this.difficulty).toBuffer();
        diffBuff.copy(padded, 32 - diffBuff.length);

        var buff = padded.slice(0, 4);
        var buffArray = buff.toByteArray().reverse();
        //buffArray = buffArray.reverse();
        var buffReversed = new Buffer(buffArray);
        this.target = buffReversed.readUInt32BE(0);
        var hex = buffReversed.toString('hex');
        return hex;
    },
    getJob: function(){
        if (!this.hi.height || (this.lastBlockHeight === currentBlockTemplate.height && !this.pendingDifficulty))
        {
            return {
                blob: '',
                job_id: '',
                target: '',
                difficulty: '',
                prev_hi: this.hi
            };
        }

        var blob = currentBlockTemplate.nextBlob();
        this.lastBlockHeight = currentBlockTemplate.height;
        var target = this.getTargetHex();

        var newJob = {
            id: utils.uid(),
            extraNonce: currentBlockTemplate.extraNonce,
            height: currentBlockTemplate.height,
            difficulty: this.difficulty,
            diffHex: this.diffHex,
            submissions: []
        };

        this.validJobs.push(newJob);

        if (this.validJobs.length > 4)
            this.validJobs.shift();

        return {
            blob: blob,
            job_id: newJob.id,
            target: target,
            difficulty: this.difficulty.toString(),
            prev_hi: this.hi
        };
    },
    checkBan: function(validShare){
        if (!banningEnabled) return;
            // Store valid/invalid shares per IP (already initialized with 0s)
	// Init global per-IP shares stats
        if (!perIPStats[this.ip]){
            perIPStats[this.ip] = { validShares: 0, invalidShares: 0 };
        }
        var stats = perIPStats[this.ip];
        validShare ? stats.validShares++ : stats.invalidShares++;

        if (stats.validShares + stats.invalidShares >= config.poolServer.banning.checkThreshold){
            if (stats.invalidShares / stats.validShares >= config.poolServer.banning.invalidPercent / 100){
                log('warn', logSystem, 'Banned %s@%s', [this.login, this.ip]);
                bannedIPs[this.ip] = Date.now();
                delete connectedMiners[this.id];
                process.send({type: 'banIP', ip: this.ip});
            }
            else{
                stats.invalidShares = 0;
                stats.validShares = 0;            
            }
        }
    },
	popAddms: function() {
        var temp = this.addms;
        this.addms = [];
        if(temp.length !== 0)
        {
            this.hi = temp[temp.length - 1].hi;
        }
        return temp;
    },
    fetchAddms: function(callback) {
        if(this.hi.height === 0
            || (this.hi.height + 1) === currentBlockTemplate.height
            || (this.addms.length && (this.addms[this.addms.length - 1].hi.height + 1) === currentBlockTemplate.height)) {
            return callback();
        }
        var miner = this;
        getAddms(this.hi, function(error, addms) {
            if(error) {
                log('error', logSystem, 'Error fetching addms');
                return callback();
            }
            miner.addms = [];
            for (var i = 0; i < addms.length; ++i) {
                var addm = addms[i];
                if(addm.hi.height > miner.hi.height) {
                    miner.addms.push(addm);
                }
            }
            callback();
        });
    }
};



function recordShareData(miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate){

    var dateNow = Date.now();
    var dateNowSeconds = dateNow / 1000 | 0;

    var redisCommands = [
        ['hincrby', config.coin + ':shares:roundCurrent', miner.login, parseInt(job.difficulty * ( 100 - parseFloat(miner.donationPercentage) ) / 100)],
        ['zadd', config.coin + ':hashrate', dateNowSeconds, [job.difficulty, miner.login, dateNow].join(':')],
        ['hincrby', config.coin + ':workers:' + miner.login, 'hashes', parseInt(job.difficulty * ( 100 - parseFloat(miner.donationPercentage) ) / 100)],
        ['hset', config.coin + ':workers:' + miner.login, 'lastShare', dateNowSeconds]
    ];
	if(miner.hasDonation === true)
	{
		for (var i=0; i < miner.donations.length;i++)
		{	
			redisCommands.push(['hincrby', config.coin + ':shares:roundCurrent', miner.donations[i][0], parseInt(job.difficulty * (miner.donations[i][1] / 100))]);
			redisCommands.push(['zadd', config.coin + ':donationHashrate', dateNowSeconds, [parseInt(job.difficulty * (miner.donations[i][1] / 100)), miner.donations[i][0], dateNow].join(':')]);
			redisCommands.push(['hincrby', config.coin + ':workers:' + miner.donations[i][0], 'hashes', parseInt(job.difficulty * (miner.donations[i][1] / 100))]);
			redisCommands.push(['hset', config.coin + ':workers:' + miner.donations[i][0], 'lastShare', dateNowSeconds]);
			
		}
	}
	
    if (blockCandidate){
        redisCommands.push(['sadd', config.coin + ':blocksPending', [job.height, currentBlockTemplate.difficulty, hashHex, Date.now() / 1000 | 0].join(':')]);
        redisCommands.push(['rename', config.coin + ':shares:roundCurrent', config.coin + ':shares:round' + job.height]);
        redisCommands.push(['hset', config.coin + ':stats', 'lastBlockFound', Date.now()]);
        //redisCommands.push(['rename', config.coin + ':shares:roundCurrent', config.coin + ':shares:round' + job.height]);
        redisCommands.push(['hgetall', config.coin + ':shares:round' + job.height]);
    }

	redisClient.multi(redisCommands).exec(function(err, replies){
        if (err){
            log('error', logSystem, 'Failed to insert share data into redis %j \n %j', [err, redisCommands]);
            return;
        }
        if (blockCandidate){
            var workerShares = replies[replies.length - 1];
            var totalShares = Object.keys(workerShares).reduce(function(p, c){
                return p + parseInt(workerShares[c]);
            }, 0);
            redisClient.zadd(config.coin + ':blocks:candidates', job.height, [
                hashHex,
                Date.now() / 1000 | 0,
                blockTemplate.difficulty,
                totalShares
            ].join(':'), function(err, result){
                if (err){
                    log('error', logSystem, 'Failed inserting block candidate %s \n %j', [hashHex, err]);
                }
            });
        }

    });
	
    log('info', logSystem, 'Accepted %s share at difficulty %d/%d from %s@%s', [shareType, job.difficulty * ((100 - miner.donationPercentage) / 100), shareDiff, miner.login, miner.ip]);
	for (var i=0; i < miner.donations.length;i++)
		{
			log('info', logSystem, 'Accepted %s  %d%% donation share at difficulty %d/%d from %s@%s', [shareType, miner.donations[i][1], job.difficulty * ((miner.donations[i][1]) / 100), shareDiff, miner.donations[i][0], miner.ip]);
		}
	
	
}

function processShare(miner, job, blockTemplate, nonce, resultHash){
    var template = new Buffer(blockTemplate.buffer.length);
    blockTemplate.buffer.copy(template);
    template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
    //var shareBuffer = cnUtil.construct_block_blob(template, new Buffer(nonce, 'hex'));
	var shareBuffer = template;
	if (typeof(nonce) === 'number' && nonce % 1 === 0) {
        var nonceBuf = bignum(nonce, 10).toBuffer();
        var bufReversed = new Buffer(nonceBuf.toJSON().reverse());
        bufReversed.copy(shareBuffer, 1);
    } else {
        new Buffer(nonce, 'hex').copy(shareBuffer, 1);
    }
    var convertedBlob;
    var hash;
    var shareType;

    if (shareTrustEnabled && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 && Math.random() > miner.trust.probability){
        hash = new Buffer(resultHash, 'hex');
        shareType = 'trusted';
    } else {
		convertedBlob = convertBlockBlob(shareBuffer);
		//XMR FIXME:
		//hash = cryptoNight(convertedBlob);
		hash = multiHashing.boolberry(convertedBlob, scratchpad, job.height);
        shareType = 'valid';
    }


    if (hash.toString('hex') !== resultHash) {
        //log('warn', logSystem, 'Bad hash from miner %s@%s', [miner.login, miner.ip]);
        log('warn', logSystem, 'Bad hash from miner ' +  miner.login + '@' + miner.ip +
            '\n scratchpadHeight.height=' + scratchpadHeight.height + ', job.height=' + job.height +
            '\n calculated hash: ' + hash.toString('hex') + ', transfered hash: ' + resultHash);
        return false;
    }

    var hashArray = hash.toByteArray().reverse();
    var hashNum = bignum.fromBuffer(new Buffer(hashArray));
    var hashDiff = diff1.div(hashNum);



    if (hashDiff.ge(blockTemplate.difficulty)){

        apiInterfaces.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function(error, result){
            if (error){
                log('error', logSystem, 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error]);
                recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
            }
            else{
                var blockFastHash = cryptoNightFast(convertedBlob || convertBlockBlob(shareBuffer)).toString('hex');                
                log('info', logSystem,
                    'Block %s found at height %d by miner %s@%s - submit result: %j',
                    [blockFastHash.substr(0, 6), job.height, miner.login, miner.ip, result]
                );
                recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate);
                //XMR FIXME:
                //jobRefresh();
				if(!isEmpty(current_alias))
				{
					log('info',logSystem,'alias created: %j', [current_alias_index]);
					redisClient.lrem(config.coin + ':aliasrequests', 0, current_alias_index, function(err)
					{
						redisClient.lpush(config.coin + ':createdaliases', current_alias_index, function(err)
						{
					current_alias_index = {};
					current_alias = {};
					reloadAliasesQue();
						});
					});
					
					
				}
            }
        });
    }

    else if (hashDiff.lt(job.difficulty)){
        log('warn', logSystem, 'Rejected low difficulty share of %s from %s@%s', [hashDiff.toString(), miner.login, miner.ip]);
        return false;
    }
    else{
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
    }

    return true;
}


function handleMinerMethod(method, params, ip, portData, sendReply, pushMessage){


    var miner = connectedMiners[params.id];
    // Check for ban here, so preconnected attackers can't continue to screw you
    if (IsBannedIp(ip)){
        sendReply('your IP is banned');
        return;
    }
    if(miner
        && params.hi
        && params.hi.height >= miner.hi.height
        //&& params.hi.height <= currentBlockTemplate.height
        && params.hi.block_id
        && /^[a-f0-9]{64}$/.test(params.hi.block_id))
    {
        miner.hi.height = params.hi.height;
        miner.hi.block_id = params.hi.block_id;
        if(params.hi.height > currentBlockTemplate.height)
        {
            log('error', logSystem, 'method ' + method + ', miner have height=' + miner.hi.height + ' bigger than currentBlockTemplate.height=' + currentBlockTemplate.height + ', refreshing job');
            //jobRefresh();

        }
    }


   switch(method){
        case 'login':
            var login = params.login;
            if (!login){
                sendReply('missing login');
                return;
            }
            var difficulty = portData.difficulty;
			var donationAddresses = new Array();
			var parsedAddresses = new Array();
			var minerTotalDonations = 0;
            var noRetarget = false;
            
			var loginsTmp = login.split(config.poolServer.userDonations.addressSeparator);
            if(config.poolServer.userDonations.enabled && loginsTmp.length > 0)
			{
				for(var ii = 0;ii<loginsTmp.length;ii++)
				{
					var splitted = loginsTmp[ii].split(config.poolServer.userDonations.percentSeparator);
					if(splitted.length > 1 )
					{
						donationAddresses.push(splitted);
					}
					else
					{
						login = splitted[ii];
					}
				}

            }

			checkDonations(donationAddresses, sendReply, parsedAddresses,function(error, donationOutput)
			{
				if (error !== false)
				{
					log('warn', logSystem, "login error: %j for login: %s", [error, login]);
					//sendReply('invalid address used for login');
					sendReply(error['message']);
					return;
				}
				var loginEndCharPostion = login.length;
				if(config.poolServer.fixedDiff.enabled) {
					loginEndCharPostion = login.indexOf(config.poolServer.fixedDiff.addressSeparator);
					if(loginEndCharPostion !== -1) {
						login = login.split(config.poolServer.fixedDiff.addressSeparator);
						noRetarget = true;
						difficulty = login[login.length-1];
						if(difficulty < config.poolServer.varDiff.minDiff) {
							difficulty = config.poolServer.varDiff.minDiff;
						}
						log('info', logSystem, 'Miner difficulty fixed to %s',  [difficulty]);
						login = login[0];
					}
				}
				checkLogin(login, sendReply, function(error, result)
				{
					if (error !== false)
					{
						log('warn', logSystem, "login error: %s", [donationOutput, error, login]);
						sendReply('invalid address used for login');
						return;
					}
					login = result;
					log('info', logSystem, 'Miner logging in as %s',  [login]);
					var minerId = utils.uid();
					for(var ix=0;ix<donationOutput.length;ix++)
					{
						if (addressBase58Prefix !== cnUtil.address_decode(new Buffer(donationOutput[ix][0]))){
						sendReply('invalid donation address');
						return;
						}
						log('info', logSystem, 'Miner set donation for %s, to %s%%',  [donationOutput[ix][0], donationOutput[ix][1]]);
						
						minerTotalDonations +=  parseFloat(donationOutput[ix][1]);
					}
					miner = new Miner(minerId, login, params.pass, ip, difficulty, noRetarget, pushMessage, donationOutput, minerTotalDonations    );
					if(params.hi
						&& params.hi.height //&& params.hi.height <= currentBlockTemplate.height
						&& params.hi.block_id
						&& /^[a-f0-9]{64}$/.test(params.hi.block_id)) {
						miner.hi.height = params.hi.height;
						miner.hi.block_id = params.hi.block_id;
						if(params.hi.height > currentBlockTemplate.height)
						{
							log('error', logSystem, 'method ' + method + ', miner have height=' + miner.hi.height + ' bigger than currentBlockTemplate.height=' + currentBlockTemplate.height + ', refreshing job');
						}
					}
					connectedMiners[minerId] = miner;
					miner.fetchAddms(function () {
						log('debug', logSystem, 'Setting up job...');
						var job = miner.getJob();
					sendReply(null, {
						id: minerId,
						//job: miner.getJob(),
						//XMR FIXME: this was not inside the fetchaddms function upstream
						//job: miner.getJob(),
						job: {     
								blob: job.blob,
								job_id: job.job_id,
								target: job.target,
								difficulty: job.difficulty,
								prev_hi: job.prev_hi,
								status: 'OK',
								addms: miner.popAddms()
						},
						status: 'OK'
					});
					log('info', logSystem, 'Miner connected %s@%s',  [params.login, miner.ip]);
					});
				});
					
			});
				
			
			
            break;
        case 'getjob':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            //sendReply(null, miner.getJob());
            //XMR FIXME:
            //sendReply(null, miner.getJob());

			miner.fetchAddms(function ()
			{
				var job = miner.getJob();
				log('debug', logSystem, 'reply1, job: ' + JSON.stringify(job));
				sendReply(null,
					{
						blob: job.blob,
						job_id: job.job_id,
						target: job.target,
						difficulty: job.difficulty,
						prev_hi: job.prev_hi,
						status: 'OK',
						addms: miner.popAddms()
					});
			});
			return;
            miner.longPoll = {
                timeout: setTimeout(function(){
                    delete miner.longPoll;
                    miner.fetchAddms(function ()
                    {
                        var job = miner.getJob();
                        log('debug', logSystem, 'reply2, job' );
                        sendReply(null, {
                            blob: job.blob,
                            job_id: job.job_id,
                            target: job.target,
                            difficulty: job.difficulty,
                            prev_hi: job.prev_hi,
                            status: 'OK',
                            addms: miner.popAddms()
                        });
                    });
                }, config.poolServer.longPolling.timeout),
                reply: sendReply
            };
            return;


            log('debug', logSystem, 'reply3, job' );
            var job = miner.getJob();
            sendReply(null, {
                blob: job.blob,
                job_id: job.job_id,
                target: job.target,
                difficulty: job.difficulty,
                prev_hi: job.prev_hi,
                status: 'OK',
                addms: miner.popAddms()
            });
            break;
        case 'submit':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();

            var job = miner.validJobs.filter(function(job){
                return job.id === params.job_id;
            })[0];

            if (!job){
                sendReply('Invalid job id');
                return;
            }

            if (!noncePattern.test(params.nonce)) {
                var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
                log('warn', logSystem, 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + minerText);
                perIPStats[miner.ip] = { validShares: 0, invalidShares: 999999 };
                miner.checkBan(false);
                sendReply('Duplicate share');
                return;
            }

            // Force lowercase for further comparison
            params.nonce = params.nonce.toLowerCase();

            if (job.submissions.indexOf(params.nonce) !== -1){
                 var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
                 log('warn', logSystem, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText);
                 perIPStats[miner.ip] = { validShares: 0, invalidShares: 999999 };
                 miner.checkBan(false);
                 sendReply('Duplicate share');
                 return;
            }
            job.submissions.push(params.nonce);

            var blockTemplate = currentBlockTemplate.height === job.height ? currentBlockTemplate : validBlockTemplates.filter(function(t){
                return t.height === job.height;
            })[0];

            if (!blockTemplate){
                sendReply('Block expired');
                return;
            }
              var blockTemplate = currentBlockTemplate;


            var shareAccepted = processShare(miner, job, blockTemplate, params.nonce, params.result);
            miner.checkBan(shareAccepted);
            if (shareTrustEnabled){
                if (shareAccepted){
                    miner.trust.probability -= shareTrustStepFloat;
                    if (miner.trust.probability < shareTrustMinFloat)
                        miner.trust.probability = shareTrustMinFloat;
                    miner.trust.penalty--;
                    miner.trust.threshold--;
                }
                else{
                    log('warn', logSystem, 'Share trust broken by %s@%s', [miner.login, miner.ip]);
                    miner.trust.probability = 1;
                    miner.trust.penalty = config.poolServer.shareTrust.penalty;
                }
            }

            if (!shareAccepted){
                sendReply('Low difficulty share');
                return;
            }

            var now = Date.now() / 1000 | 0;
            miner.shareTimeRing.append(now - miner.lastShareTime);
            miner.lastShareTime = now;
            //miner.retarget(now);

            sendReply(null, {status: 'OK'});
            break;
        case 'getfullscratchpad':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.hi = scratchpadHeight;
            sendReply(null, {status: 'OK', hi: scratchpadHeight, scratchpad_hex: scratchpad.toString('hex')});
            break;
        default:
            sendReply("invalid method");
            var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
            log('warn', logSystem, 'Invalid method: %s (%j) from %s', [method, params, minerText]);
            break;
    }
}


var httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nmining server online';


function startPoolServerTcp(callback){
    async.each(config.poolServer.ports, function(portData, cback){
        var handleMessage = function(socket, jsonData, pushMessage){
            if (!jsonData.id) {
                log('warn', logSystem, 'Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                log('warn', logSystem, 'Miner RPC request missing RPC method');
                return;
            }
            else if (!jsonData.params) {
                log('warn', logSystem, 'Miner RPC request missing RPC params');
                return;
            }

            var sendReply = function(error, result){
                if(!socket.writable) return;
                var sendData = JSON.stringify({
                    id: jsonData.id,
                    jsonrpc: "2.0",
                    error: error ? {code: -1, message: error} : null,
                    result: result
                }) + "\n";
                socket.write(sendData);
            };

            handleMinerMethod(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage);
        };

        net.createServer(function(socket){
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            var dataBuffer = '';

            var pushMessage = function(method, params){
                if(!socket.writable) return;
                var sendData = JSON.stringify({
                    jsonrpc: "2.0",
                    method: method,
                    params: params
                }) + "\n";
                socket.write(sendData);
            };

            socket.on('data', function(d){
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                    dataBuffer = null;
                    log('warn', logSystem, 'Socket flooding detected and prevented from %s', [socket.remoteAddress]);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1){
                    var messages = dataBuffer.split('\n');
                    var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    for (var i = 0; i < messages.length; i++){
                        var message = messages[i];
                        if (message.trim() === '') continue;
                        var jsonData;
                        try{
                            jsonData = JSON.parse(message);
                        }
                        catch(e){
                            if (message.indexOf('GET /') === 0) {
                                if (message.indexOf('HTTP/1.1') !== -1) {
                                    socket.end('HTTP/1.1' + httpResponse);
                                    break;
                                }
                                else if (message.indexOf('HTTP/1.0') !== -1) {
                                    socket.end('HTTP/1.0' + httpResponse);
                                    break;
                                }
                            }

                            log('warn', logSystem, 'Malformed message from %s: %s', [socket.remoteAddress, message]);
                            socket.destroy();

                            break;
                        }
                        handleMessage(socket, jsonData, pushMessage);
                    }
                    dataBuffer = incomplete;
                }
            }).on('error', function(err){
                if (err.code !== 'ECONNRESET')
                    log('warn', logSystem, 'Socket error from %s %j', [socket.remoteAddress, err]);
            }).on('close', function(){
                pushMessage = function(){};
            });

        }).listen(portData.port, function (error, result) {
            if (error) {
                log('error', logSystem, 'Could not start server listening on port %d, error: $j', [portData.port, error]);
                cback(true);
                return;
            }
            log('info', logSystem, 'Started server listening on port %d', [portData.port]);
            cback();
        });

    }, function(err){
        if (err)
            callback(false);
        else
            callback(true);
    });
}
