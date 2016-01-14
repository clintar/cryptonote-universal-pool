var fs = require('fs');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);


var logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);


log('info', logSystem, 'Started');
function checkaddress(address, callback)
{
	//log('warn', logSystem, 'Checking %s for alias', [address]);
	myerror = false;
	if(address.indexOf('%40') === 0)
		address = address.substr(4);
	if(address.indexOf('@') === 0)
	{
		address = address.substr(1); 
		apiInterfaces.rpcDaemon('get_alias_details', {alias: address} , function (error, result)
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
			address = result.alias_details.address;
			callback(myerror, address);
		});
	}
	else
	{
		callback(myerror, address);
	}
}

function runInterval(){
    apiInterfaces.rpcWallet('getbalance', '', function(error, result){
        if (error){
                log('error', logSystem, 'Error with transfer RPC request to wallet daemon %j', [error]);
                log('error', logSystem, 'Could not retrieve wallet balance ');
                return;
        }
        log('info', logSystem, 'Wallet daemon reports balance: %d, Unlocked : %d', [result.balance / config.coinUnits, result.unlocked_balance / config.coinUnits]);
    });
    var remainingWorkerBalancesBelowMin = 0;
    async.waterfall([

        //Get worker keys
        function(callback){
            redisClient.keys(config.coin + ':workers:*', function(error, result) {
                if (error) {
                    log('error', logSystem, 'Error trying to get worker balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, result);
            });
        },

        //Get worker balances
        function(keys, callback){
            var redisCommands = keys.map(function(k){
                return ['hget', k, 'balance'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                var balances = {};
                for (var i = 0; i < replies.length; i++){
                    var parts = keys[i].split(':');
                    var workerId = parts[parts.length - 1];
                    balances[workerId] = parseInt(replies[i]) || 0

                }
                callback(null, balances);
            });
        },

        //Filter workers under balance threshold for payment
        function(balances, callback){

            var payments = {};
            for (var worker in balances){
                var balance = balances[worker];
                if (balance >= config.payments.minPayment){
                    var remainder = balance % config.payments.denomination;
                    var payout = balance - remainder;
                    if (payout < 0) continue;
                    payments[worker] = payout;
                }
                else
                {
                    if(balance > 0)
                    {
                        remainingWorkerBalancesBelowMin = remainingWorkerBalancesBelowMin + balance;
                        log('debug', logSystem, 'Worker %s below minimum payment threshold: %d', [worker, balance / config.coinUnits]);
                    }
                }
            }
            if(remainingWorkerBalancesBelowMin > 0)
            {
                log('info', logSystem, 'Total balances below minimum payment threshold: %d', [remainingWorkerBalancesBelowMin / config.coinUnits]);
            }
            
            if (Object.keys(payments).length === 0){
                log('info', logSystem, 'No workers\' balances reached the minimum payment threshold');
                
                callback(true);
                return;
            }

            var transferCommands = [];
            var addresses = 0;
            var commandAmount = 0;
            var commandIndex = 0;
            var maxReached = false;
            for (var worker in payments){
                checkaddress(worker, function(error, newaddress) {
                var amount = parseInt(payments[worker]);
				if(config.payments.maxTransactionAmount && amount + commandAmount > config.payments.maxTransactionAmount) {
		            amount = config.payments.maxTransactionAmount - commandAmount;
		            maxReached = true;
	            }
				
				if(!transferCommands[commandIndex]) {
					transferCommands[commandIndex] = {
						redis: [],
						amount : 0,
						rpc: {
							destinations: [],
							fee: config.payments.transferFee,
							mixin: config.payments.mixin,
							unlock_time: 0
						}
					};
				}
				
                transferCommands[commandIndex].rpc.destinations.push({amount: amount, address: newaddress});
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
                transferCommands[commandIndex].amount += amount;

                addresses++;
				commandAmount += amount;
                if (addresses >= config.payments.maxAddresses || ( config.payments.maxTransactionAmount && commandAmount >= config.payments.maxTransactionAmount)) {
                    commandIndex++;
                    addresses = 0;
                    commandAmount = 0;
                }
				});
            }

            var timeOffset = 0;

            async.filter(transferCommands, function(transferCmd, cback){
                apiInterfaces.rpcWallet('transfer', transferCmd.rpc, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with transfer RPC request to wallet daemon %j', [error]);
                        log('error', logSystem, 'Payments failed to send to %j', transferCmd.rpc.destinations);
                        cback(false);
                        return;
                    }
                    var amountTotals = 0;
                    var feeTotals = 0;
                    var now = (timeOffset++) + Date.now() / 1000 | 0;
                    var txHash = result.tx_hash.replace('<', '').replace('>', '');


                    transferCmd.redis.push(['zadd', config.coin + ':payments:all', now, [
                        txHash,
                        transferCmd.amount,
                        transferCmd.rpc.fee,
                        transferCmd.rpc.mixin,
                        Object.keys(transferCmd.rpc.destinations).length
                    ].join(':')]);


                    for (var i = 0; i < transferCmd.rpc.destinations.length; i++){
                        var destination = transferCmd.rpc.destinations[i];
                        amountTotals += destination.amount;
                        feeTotals += transferCmd.rpc.fee;
                        transferCmd.redis.push(['zadd', config.coin + ':payments:' + destination.address, now, [
                            txHash,
                            destination.amount,
                            transferCmd.rpc.fee,
                            transferCmd.rpc.mixin
                        ].join(':')]);
                    }


                    log('info', logSystem, 'Payments totalling: %d, with fees of %d, sent via wallet daemon %j', [amountTotals / config.coinUnits, feeTotals / config.coinUnits, result]);
                    redisClient.multi(transferCmd.redis).exec(function(error, replies){
                        if (error){
                            log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error]);
                            log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.destinations);
                            cback(false);
                            return;
                        }
                        cback(true);
                    });
                });
            }, function(succeeded){
                var failedAmount = transferCommands.length - succeeded.length;
                log('info', logSystem, 'Payments splintered and %d successfully sent, %d failed', [succeeded.length, failedAmount]);
                if(failedAmount){
                    callback(null);
                }
                else
                {
                    callback(null, maxReached);
                }
            });

        }

    ], function(error, result){
        if(!error && result)
        {
            log('info', logSystem, 'Max amount reached. Will attempt another payment in 5 seconds since full payout did not happen.');
            setTimeout(runInterval, 5000);
        }
        else
        {
            apiInterfaces.rpcWallet('getbalance', '', function(error, result){
                if (error){
                        log('error', logSystem, 'Error with transfer RPC request to wallet daemon %j', [error]);
                        log('error', logSystem, 'Could not retrieve wallet balance ');
                        return;
                }
                log('info', logSystem, 'Wallet balance after payments processed: %d, Unlocked: %d', [result.balance / config.coinUnits, result.unlocked_balance / config.coinUnits]);
                async.waterfall([

                    //Get all block candidates in redis
                    function(callback){
                        redisClient.zrange(config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES', function(error, results){
                            if (error){
                                log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
                                callback(true);
                                return;
                            }
                            if (results.length === 0){
                                log('info', logSystem, 'No blocks candidates in redis');
                                callback(true);
                                return;
                            }

                            var blocks = [];

                            for (var i = 0; i < results.length; i += 2){
                                var parts = results[i].split(':');
                                blocks.push({
                                    serialized: results[i],
                                    height: parseInt(results[i + 1]),
                                    hash: parts[0],
                                    time: parts[1],
                                    difficulty: parts[2],
                                    shares: parts[3]
                                });
                            }

                            callback(null, blocks);
                        });
                    },

                    //Check if blocks are orphaned
                    function(blocks, callback){
                        async.filter(blocks, function(block, mapCback){
                            apiInterfaces.rpcDaemon('getblockheaderbyheight', {height: block.height}, function(error, result){
                                if (error){
                                    log('error', logSystem, 'Error with getblockheaderbyheight RPC request for block %s - %j', [block.serialized, error]);
                                    block.pending = false;
                                    mapCback();
                                    return;
                                }
                                if (!result.block_header){
                                    log('error', logSystem, 'Error with getblockheaderbyheight, no details returned for %s - %j', [block.serialized, result]);
                                    block.pending = false;
                                    mapCback();
                                    return;
                                }
                                var blockHeader = result.block_header;
                                block.orphaned = blockHeader.hash === block.hash ? 0 : 1;
                                block.pending = blockHeader.depth < config.blockUnlocker.depth;
                                block.reward = blockHeader.reward;
                                mapCback(block.pending);
                            });
                        }, function(unlockedBlocks){

                            if (unlockedBlocks.length === 0){
                                log('info', logSystem, 'No pending blocks');
                                callback(true);
                                return;
                            }

                            callback(null, unlockedBlocks)
                        })
                    },

                    //Handle pending blocks
                    function(blocks, callback){
                        var totalBlocksPending = 0;
                        var feePercent = config.blockUnlocker.poolFee / 100;
                        var totalPendingPoolReward = 0;
                        blocks.forEach(function(block){
                            if (block.orphaned) return;
                            totalBlocksPending++;
                            totalPendingPoolReward = totalPendingPoolReward + block.reward;
                        });
                        if (totalPendingPoolReward === 0){
                            log('info', logSystem, 'No pending reward');
                            callback(true);
                            return;
                        }
                        else
                        {
                            log('info', logSystem, '%d pending blocks with miner rewards totaling: %d, with total pool reward: %d ', [totalBlocksPending, (totalPendingPoolReward * ((100 - config.blockUnlocker.poolFee) / 100) )  / config.coinUnits, (totalPendingPoolReward * feePercent) / config.coinUnits]);
                            log('info', logSystem, 'Potential current pool reserves (assuming payments processed and blocks will mature) after payout to miners: %d ', [result.balance / config.coinUnits + ((totalPendingPoolReward * feePercent) / config.coinUnits) - (totalPendingPoolReward * ((100 - config.blockUnlocker.poolFee) / 100) )  / config.coinUnits - remainingWorkerBalancesBelowMin / config.coinUnits]);
                        }
                    }
                ], function(error, result){

                });
            });
            setTimeout(runInterval, config.payments.interval * 1000);
        }
    });
}

runInterval();
