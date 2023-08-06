import { ConfigService } from '@nestjs/config';
import Big from 'big.js';
import * as bitcoinjs from 'bitcoinjs-lib';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import PromiseSocket from 'promise-socket';
import { firstValueFrom, Subscription } from 'rxjs';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';


export class StratumV1Client {

    private clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;
    private stratumSubscription: Subscription;
    private backgroundWork: NodeJS.Timer;

    private statistics: StratumV1ClientStatistics;
    private stratumInitialized = false;
    private usedSuggestedDifficulty = false;
    private sessionDifficulty: number = 16384;
    private entity: ClientEntity;

    public extraNonceAndSessionId: string;

    public sessionStart: Date;


    constructor(
        public readonly promiseSocket: PromiseSocket<Socket>,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService
    ) {

        this.promiseSocket.socket.on('data', (data: Buffer) => {
            data.toString()
                .split('\n')
                .filter(m => m.length > 0)
                .forEach(async (m) => {
                    try {
                        await this.handleMessage(m);
                    } catch (e) {
                        await this.promiseSocket.end();
                        console.error(e);
                    }
                })
        });

        this.sessionStart = new Date();
        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService, this.clientService);
        this.extraNonceAndSessionId = this.getRandomHexString();
        console.log(`New client ID: : ${this.extraNonceAndSessionId}`);
    }

    public destroy() {
        if (this.stratumSubscription != null) {
            this.stratumSubscription.unsubscribe();
        }
        if (this.backgroundWork != null) {
            clearInterval(this.backgroundWork);
        }
    }

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
        const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
        const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
        return hexString;
    }


    private async handleMessage(message: string) {
        //console.log(`Received from ${this.extraNonceAndSessionId}`, message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.log("Invalid JSON");
            await this.promiseSocket.end();
            return;
        }


        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                const subscriptionMessage = plainToInstance(
                    SubscriptionMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(subscriptionMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientSubscription = subscriptionMessage;

                    await this.promiseSocket.write(JSON.stringify(this.clientSubscription.response(this.extraNonceAndSessionId)) + '\n');
                } else {
                    console.error('Subscription validation error');
                    const err = new StratumErrorMessage(
                        subscriptionMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Subscription validation error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }

                break;
            }
            case eRequestMethod.CONFIGURE: {

                const configurationMessage = plainToInstance(
                    ConfigurationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(configurationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientConfiguration = configurationMessage;
                    //const response = this.buildSubscriptionResponse(configurationMessage.id);
                    await this.promiseSocket.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                } else {
                    console.error('Configuration validation error');
                    const err = new StratumErrorMessage(
                        configurationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Configuration validation error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }

                break;
            }
            case eRequestMethod.AUTHORIZE: {
                const authorizationMessage = plainToInstance(
                    AuthorizationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(authorizationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientAuthorization = authorizationMessage;

                    //const response = this.buildSubscriptionResponse(authorizationMessage.id);
                    await this.promiseSocket.write(JSON.stringify(this.clientAuthorization.response()) + '\n');
                } else {
                    console.error('Authorization validation error');
                    const err = new StratumErrorMessage(
                        authorizationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Authorization validation error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }

                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                if (this.usedSuggestedDifficulty == true) {
                    return;
                }

                const suggestDifficultyMessage = plainToInstance(
                    SuggestDifficulty,
                    parsedMessage
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(suggestDifficultyMessage, validatorOptions);

                if (errors.length === 0) {

                    this.clientSuggestedDifficulty = suggestDifficultyMessage;
                    this.sessionDifficulty = suggestDifficultyMessage.suggestedDifficulty;
                    await this.promiseSocket.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                    this.usedSuggestedDifficulty = true;
                } else {
                    console.error('Suggest difficulty validation error');
                    const err = new StratumErrorMessage(
                        suggestDifficultyMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Suggest difficulty validation error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }
                break;
            }
            case eRequestMethod.SUBMIT: {
                const miningSubmitMessage = plainToInstance(
                    MiningSubmitMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(miningSubmitMessage, validatorOptions);

                if (errors.length === 0 && this.stratumInitialized == true) {
                    const result = await this.handleMiningSubmission(miningSubmitMessage);
                    if (result == true) {
                        await this.promiseSocket.write(JSON.stringify(miningSubmitMessage.response()) + '\n');
                    }


                } else {
                    console.error('Mining Submit validation error');
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Mining Submit validation error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }
                break;
            }
        }


        if (this.clientSubscription != null
            && this.clientAuthorization != null
            && this.stratumInitialized == false) {

            this.stratumInitialized = true;

            switch (this.clientSubscription.userAgent) {
                case 'cpuminer': {
                    this.sessionDifficulty = 0.1;
                }
            }


            if (this.clientSuggestedDifficulty == null) {
                console.log(`Setting difficulty to ${this.sessionDifficulty}`)
                const setDifficulty = JSON.stringify(new SuggestDifficulty().response(this.sessionDifficulty));
                await this.promiseSocket.write(setDifficulty + '\n');
            }



            this.entity = await this.clientService.insert({
                sessionId: this.extraNonceAndSessionId,
                address: this.clientAuthorization.address,
                clientName: this.clientAuthorization.worker,
                userAgent: this.clientSubscription.userAgent,
                startTime: new Date(),
                bestDifficulty: 0
            });

            this.stratumSubscription = this.stratumV1JobsService.newMiningJob$.pipe(
            ).subscribe(async (jobTemplate) => {
                try {
                    await this.sendNewMiningJob(jobTemplate);
                } catch (e) {
                    await this.promiseSocket.end();
                    console.error(e);
                }
            });

            this.backgroundWork = setInterval(async () => {
                await this.checkDifficulty();
                //await this.watchdog();
            }, 60 * 1000);

        }
    }

    // private async watchdog() {
    //     let time = await this.statistics.getLastSubmissionTime();
    //     if (time == null) {
    //         time = this.sessionStart;
    //     }
    //     const now = Date.now();
    //     const diffSeconds = (now - time.getTime()) / 1000;
    //     // one hour
    //     if (diffSeconds > 60 * 60) {
    //         console.log(`Watchdog ending session ${this.extraNonceAndSessionId}}`);
    //         await this.promiseSocket.end();
    //     }
    // }

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {

        const hashRate = await this.clientStatisticsService.getHashRateForSession(this.clientAuthorization.address, this.clientAuthorization.worker, this.extraNonceAndSessionId);

        let payoutInformation;
        const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
        //50Th/s
        const noFee = hashRate != 0 && hashRate < 50000000000000;
        if (noFee || devFeeAddress == null || devFeeAddress.length < 1) {
            payoutInformation = [
                { address: this.clientAuthorization.address, percent: 100 }
            ];

        } else {
            payoutInformation = [
                { address: devFeeAddress, percent: 1.5 },
                { address: this.clientAuthorization.address, percent: 98.5 }
            ];
        }


        const job = new MiningJob(
            this.configService.get('NETWORK') === 'mainnet' ? bitcoinjs.networks.bitcoin : bitcoinjs.networks.testnet,
            this.stratumV1JobsService.getNextId(),
            payoutInformation,
            jobTemplate
        );

        this.stratumV1JobsService.addJob(job);

        try {
            await this.promiseSocket.write(job.response(jobTemplate));
        } catch (e) {
            console.log(e);
        }


        console.log(`Sent new job to ${this.clientAuthorization.worker}.${this.extraNonceAndSessionId}. (clearJobs: ${jobTemplate.blockData.clearJobs}, fee?: ${!noFee})`)

    }


    private async handleMiningSubmission(submission: MiningSubmitMessage) {

        const job = this.stratumV1JobsService.getJobById(submission.jobId);

        // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification
        if (job == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found').response();
            console.log(err);
            await this.promiseSocket.write(err);
            return false;
        }
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);

        const updatedJobBlock = job.copyAndUpdateBlock(
            jobTemplate,
            parseInt(submission.versionMask, 16),
            parseInt(submission.nonce, 16),
            this.extraNonceAndSessionId,
            submission.extraNonce2,
            parseInt(submission.ntime, 16)
        );
        const header = updatedJobBlock.toBuffer(true);
        const { submissionDifficulty, submissionHash } = this.calculateDifficulty(header);

        //console.log(`DIFF: ${submissionDifficulty} of ${this.sessionDifficulty} from ${this.clientAuthorization.worker + '.' + this.extraNonceAndSessionId}`);


        if (submissionDifficulty >= this.sessionDifficulty) {

            if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
                console.log('!!! BLOCK FOUND !!!');
                const blockHex = updatedJobBlock.toHex(false);
                const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
                await this.blocksService.save({
                    height: jobTemplate.blockData.height,
                    minerAddress: this.clientAuthorization.address,
                    worker: this.clientAuthorization.worker,
                    sessionId: this.extraNonceAndSessionId,
                    blockData: blockHex
                });

                await this.notificationService.notifySubscribersBlockFound(this.clientAuthorization.address, jobTemplate.blockData.height, updatedJobBlock, result);
                //success
                if (result == null) {
                    await this.addressSettingsService.resetBestDifficultyAndShares();
                }
            }
            try {
                await this.statistics.addSubmission(this.entity, submissionHash, this.sessionDifficulty);
                //await this.addressSettingsService.addShares(this.clientAuthorization.address, this.sessionDifficulty);
            } catch (e) {
                console.log(e);
                const err = new StratumErrorMessage(
                    submission.id,
                    eStratumErrorCode.DuplicateShare,
                    'Duplicate share').response();
                console.error(err);
                await this.promiseSocket.write(err);
                return false;
            }

            if (submissionDifficulty > this.entity.bestDifficulty) {
                await this.clientService.updateBestDifficulty(this.extraNonceAndSessionId, submissionDifficulty);
                this.entity.bestDifficulty = submissionDifficulty;
                if (submissionDifficulty > (await this.addressSettingsService.getSettings(this.clientAuthorization.address)).bestDifficulty) {
                    await this.addressSettingsService.updateBestDifficulty(this.clientAuthorization.address, submissionDifficulty);
                }
            }



        } else {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.LowDifficultyShare,
                'Difficulty too low').response();
            // console.error(err);
            // console.log(`Header: ${header.toString('hex')}`);
            try {
                await this.promiseSocket.write(err);
            } catch (e) {
                await this.promiseSocket.end();
                console.error(e);
            }
            return false;
        }

        //await this.checkDifficulty();
        return true;

    }

    private async checkDifficulty() {
        const targetDiff = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
        if (targetDiff == null) {
            return;
        }

        if (targetDiff != this.sessionDifficulty) {
            console.log(`Adjusting difficulty from ${this.sessionDifficulty} to ${targetDiff}`);
            this.sessionDifficulty = targetDiff;

            const data = JSON.stringify({
                id: null,
                method: eResponseMethod.SET_DIFFICULTY,
                params: [targetDiff]
            }) + '\n';

            try {
                await this.promiseSocket.write(data);
            } catch (e) {
                await this.promiseSocket.end();
                return;
            }

            // we need to clear the jobs so that the difficulty set takes effect. Otherwise the different miner implementations can cause issues
            const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
            await this.sendNewMiningJob(jobTemplate);

        }
    }

    private calculateDifficulty(header: Buffer): { submissionDifficulty: number, submissionHash: string } {

        const hashResult = bitcoinjs.crypto.hash256(header);

        let s64 = this.le256todouble(hashResult);

        const truediffone = Big('26959535291011309493156476344723991336010898738574164086137773096960');
        const difficulty = truediffone.div(s64.toString());
        return { submissionDifficulty: difficulty.toNumber(), submissionHash: hashResult.toString('hex') };
    }


    private le256todouble(target: Buffer): bigint {

        const number = target.reduceRight((acc, byte) => {
            // Shift the number 8 bits to the left and OR with the current byte
            return (acc << BigInt(8)) | BigInt(byte);
        }, BigInt(0));

        return number;
    }

}