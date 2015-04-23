/* 
 * To change this template, choose Tools | Templates
 * and open the template in the editor.
 */


var fs = require('fs');

var async = require('async');
var crypto = require('crypto');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api, config.purchasesWallet);


var logSystem = 'purchases';
require('./exceptionWriter.js')(logSystem);

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
function sendConfirmation(request) {
    var nodemailer = require('nodemailer');
    var transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: 'cncoinpayments@gmail.com',
            pass: 'myvbifrqjfirczhj'
        }
    });
    transporter.sendMail({
        from: config.purchases.supportEmail,
        to: request.email,
        subject: 'cncoin.farm Alias Payment received',
        text: 'Thank you for your alias request payment!\n\
	Request info:\n\
	Alias: ' + request.alias + '\n\
	' + config.symbol + ' Address: ' + request.address + ' \n\
	 \n\
	Your alias is the next in the queue to be created!\n\
	\n\
	If you have any issues with this alias creation, email me at ' + config.purchases.supportEmail + '\n\
	\n\
	Thank you'
											});
}

function checkForPayment(request)
{
    var rpc = {
        payment_id: request.paymentid
    };
    if(request.paid !== '1')
    {
        var index = config.coin + ':aliasrequest:' + request.alias;
        log('info', logSystem, 'alias request pending payment %s',[index]);
        apiInterfaces.rpcPaymentWallet('get_payments', rpc, function(error, plist){
            if(!error)
            {
                var index = config.coin + ':aliasrequest:' + request.alias;
                //log('info', logSystem, 'checking index: %j, request: %j', [index, request]);
                if (plist && plist.payments && plist.payments.length > 0)
                {
                    var total_paid = 0;
                    var expected_amount = config.purchases.requiredAmount * config.coinUnits;
                    for(var i=0;i<plist.payments.length;i++)
                    {
                        total_paid+=plist.payments[i].amount;
                    }
                    if(total_paid < expected_amount)
                    {
                        log('warn', logSystem, 'payment_id found, but less than expected amount: %d - paid %d', [expected_amount, total_paid]);
                    }
                    else if(request.paid !== '1')
                    {
                        log('info', logSystem, 'payment_id found, expected amount: %d vs. %d - index: %j, request: %j', [expected_amount, total_paid, index, request]);
                        redisClient.persist(index);
                        redisClient.hmset(index, 'paid', '1');
                        sendConfirmation(request, index);
                    }
                }
                else
                {
                    //log('error', logSystem, 'payment_id not found for: %j , output %j', [rpc,result]);
                }

            }
            else
            {
                log('error', logSystem, 'Error with transfer RPC request to wallet daemon %j', [rpc.payment_id, error]);
            }
        });
    }
}

function runInterval(){
		if(config.purchases.enabled == false)
		{
			return;
		}

		
		redisClient.lrange(
				config.coin + ':aliasrequests', 
				0 , 
				-1,
			function(err, result){
				var index;
				for (var i = 0;i < result.length;i++)
				{
					index = result[i];
					redisClient.hgetall(index, function(err1, request){
						var index = config.coin + ':aliasrequest:' + request.alias;
						if(err1 || request === null)
						{
							log('error', logSystem, 'alias request not found, perhaps it expired... removing: ', [index]);
							redisClient.lrem(config.coin + ':aliasrequests', -1, index,
							function(err, aresult){
								if(err)
								{
									log('error', logSystem, 'alias request not found, and could not remove from list %s' ,[err]);
								}
							});
							return;
						}
                        checkForPayment(result);
						
						
					});
					
				}
			});

		
        setTimeout(runInterval, 1 * config.purchases.checkInterval);

}
runInterval();