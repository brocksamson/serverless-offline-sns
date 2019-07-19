import { SNSAdapter } from "./sns-adapter";
import * as express from "express";
import * as cors from "cors";
import * as bodyParser from "body-parser";
import { ISNSAdapter } from "./types";
import { SNSServer } from "./sns-server";
import * as _ from "lodash";
import * as AWS from "aws-sdk";
import { resolve } from "path";

import { fork, spawn } from "child_process";
import * as trimNewlines from "trim-newlines";

class ServerlessOfflineSns {
    private config: any;
    private serverless: any;
    public commands: object;
    private port: number;
    public hooks: object;
    private snsAdapter: ISNSAdapter;
    private app: any;
    private snsServer: any;
    private server: any;
    private options: any;
    private location: string;
    private region: string;
    private accountId: string;

    constructor(serverless: any, options: any) {
        this.app = express();
        this.app.use(cors());
        this.app.use(bodyParser.json({ type: ["application/json", "text/plain"] }));
        this.options = options;
        this.serverless = serverless;

        this.commands = {
            "offline-sns": {
                usage: "Listens to offline SNS events and passes them to configured Lambda fns",
                lifecycleEvents: [
                    "start",
                ],
                commands: {
                    start: {
                        lifecycleEvents: [
                            "init",
                            "end",
                        ],
                    },
                },
            },
        };

        this.hooks = {
            "before:offline:start:init": () => this.start(),
            "after:offline:start:end": () => this.stop(),
            "offline-sns:start:init": () => {
                this.start();
                return this.waitForSigint();
            },
            "offline-sns:start:end": () => this.stop(),
        };
    }

    public init() {
        process.env = _.extend({}, this.serverless.service.provider.environment, process.env);
        this.config = this.serverless.service.custom["serverless-offline-sns"] || {};
        this.port = this.config.port || 4002;
        this.accountId = this.config.accountId || "123456789012";
        const offlineConfig = this.serverless.service.custom["serverless-offline"] || {};
        this.location = process.cwd();
        const locationRelativeToCwd = this.options.location || offlineConfig.location;
        if (locationRelativeToCwd) {
            this.location = process.cwd() + "/" + locationRelativeToCwd;
        } else if (this.serverless.config.servicePath) {
            this.location = this.serverless.config.servicePath;
        }
        if (this.serverless.service.provider.region) {
            this.region = this.serverless.service.provider.region;
        } else {
            this.region = "us-east-1";
        }

        // Congure SNS client to be able to find us.
        AWS.config.sns = {
            endpoint: "http://127.0.0.1:" + this.port,
            region: this.region,
        };
    }

    public async start() {
        this.init();
        await this.listen();
        await this.serve();
        await this.subscribeAll();
        return this.snsAdapter;
    }

    public async waitForSigint() {
        return new Promise(res => {
            process.on("SIGINT", () => {
                this.log("Halting offline-sns server");
                res();
            });
        });
    }

    public async serve() {
        this.snsServer = new SNSServer((msg, ctx) => this.debug(msg, ctx), this.app, this.region, this.accountId);
    }

    public async subscribeAll() {
        this.snsAdapter = new SNSAdapter(
            this.port,
            this.serverless.service.provider.region,
            this.config["sns-endpoint"],
            (msg, ctx) => this.debug(msg, ctx),
            this.app,
            this.serverless.service.service,
            this.serverless.service.provider.stage,
            this.accountId,
            this.config.host,
            this.config["sns-subscribe-endpoint"],
        );
        await this.unsubscribeAll();
        this.debug("subscribing");
        await Promise.all(Object.keys(this.serverless.service.functions).map(fnName => {
            const fn = this.serverless.service.functions[fnName];
            return Promise.all(fn.events.filter(event => event.sns != null).map(event => {
                return this.subscribe(fnName, event.sns);
            }));
        }));
    }

    public async unsubscribeAll() {
        const subs = await this.snsAdapter.listSubscriptions();
        this.debug("subs!: " + JSON.stringify(subs));
        await Promise.all(
            subs.Subscriptions
                .filter(sub => sub.Endpoint.indexOf(":" + this.port) > -1)
                .map(sub => this.snsAdapter.unsubscribe(sub.SubscriptionArn)));
    }

    public async subscribe(fnName, snsConfig) {
        this.debug("subscribe: " + fnName);
        // name = event.sns ||
        // name = event.sns.topicName ||
        // arn = event.sns.arn ||
        // arn = event.sns.arn && topicName = event.sns.topicName
        const fn = this.serverless.service.functions[fnName];
        if (typeof snsConfig === "string" || typeof snsConfig.topicName === "string") {
            let topicName = "";
            // According to Serverless docs, if the sns config is a string,
            // that string must be the topic ARN:
            // https://serverless.com/framework/docs/providers/aws/events/sns#using-a-pre-existing-topic
            if (typeof snsConfig === "string" && snsConfig.indexOf("arn:aws:sns") === 0) {
                const snsConfigParts = snsConfig.split(":");
                // the topics name is that last part of the ARN:
                // arn:aws:sns:<REGION>:<ACCOUNT_ID>:<TOPIC_NAME>
                topicName = snsConfigParts[snsConfigParts.length - 1];
            } else if (snsConfig.topicName && typeof snsConfig.topicName === "string") {
                topicName = snsConfig.topicName;
            }

            if (!topicName) {
                return Promise.resolve(`Unable to create topic for "${fnName}". Please ensure the sns configuration is correct.`);
            }

            this.log(`Creating topic: "${topicName}" for fn "${fnName}"`);
            const data = await this.snsAdapter.createTopic(topicName);
            this.debug("topic: " + JSON.stringify(data));
            await this.snsAdapter.subscribe(fn, () => this.createHandler(fnName, fn), data.TopicArn, snsConfig);
        } else if (typeof snsConfig.arn === "string") {
            await this.snsAdapter.subscribe(fn, () => this.createHandler(fnName, fn), snsConfig.arn, snsConfig);
        } else {
            this.log("unsupported config: " + snsConfig);
            return Promise.resolve("unsupported config: " + snsConfig);
        }
    }

    public createHandler(fnName, fn) {
        if (!fn.runtime || fn.runtime.startsWith("nodejs")) {
            return this.createJavascriptHandler(fn);
        } else {
            return this.createProxyHandler(fnName, fn);
        }
    }

    public createProxyHandler(funName, funOptions) {
        const options = this.options;
        // stolen from serverless-offline as POC to see if python lambdas can be run in offline-sns.
        // long term plan, depend on serverless-offline if its installed to handle non js execution
        return (event, context) => {
            const args = ["invoke", "local", "-f", funName];
            const stage = options.s || options.stage;

            if (stage) {
                args.push("-s", stage);
            }

            // Use path to binary if provided, otherwise assume globally-installed
            const binPath = options.b || options.binPath;
            const cmd = binPath || "sls";

            const process = spawn(cmd, args, {
                cwd: funOptions.servicePath,
                shell: true,
                stdio: ["pipe", "pipe", "pipe"],
            });

            process.stdin.write(`${JSON.stringify(event)}\n`);
            process.stdin.end();

            let results = [];
            let hasDetectedJson = false;

            process.stdout.on("data", (data) => {
                results.push(data.toString());
            });

            process.stderr.on("data", data => {
                context.fail(data);
            });

            process.on("close", code => {
                if (code.toString() === "0") {
                    // try to parse to json
                    // valid result should be a json array | object
                    // technically a string is valid json
                    // but everything comes back as a string
                    // so we can't reliably detect json primitives with this method
                    let response = null;
                    // we go end to start because the one we want should be last
                    // or next to last
                    for (let i = results.length - 1; i >= 0; i--) {
                        // now we need to find the min | max [] or {} within the string
                        // if both exist then we need the outer one.
                        // { "something": [] } is valid,
                        // [{"something": "valid"}] is also valid
                        // *NOTE* Doesn't currently support 2 separate valid json bundles
                        // within a single result.
                        // this can happen if you use a python logger
                        // and then do log.warn(json.dumps({'stuff': 'here'}))
                        const item = results[i];
                        const firstCurly = item.indexOf('{');
                        const firstSquare = item.indexOf('[');
                        let start = 0;
                        let end = item.length;
                        if(firstCurly === -1 && firstSquare === -1){
                            // no json found
                            continue;
                        }
                        if(firstSquare === -1 || firstCurly < firstSquare){
                            // found an object
                            start = firstCurly;
                            end = item.lastIndexOf('}') + 1;
                        } else if(firstCurly === -1 || firstSquare < firstCurly){
                            // found an array
                            start = firstSquare;
                            end = item.lastIndexOf(']') + 1;
                        }

                        try {
                            response = JSON.parse(item.substring(start, end));
                            break;
                        } catch (err) {
                            // not json, check the next one
                            continue;
                        }
                    }
                    if(response !== null){
                        context.succeed(response);
                    } else {
                        context.fail(results.join('\n'));
                    }

                } else {
                    // this seems wrong, should we succeed here?
                    context.succeed(code, results);
                }
            });
        };
    }

    public createJavascriptHandler(fn) {

        // use the main serverless config since this behavior is already supported there
        if (!this.serverless.config.skipCacheInvalidation || Array.isArray(this.serverless.config.skipCacheInvalidation)) {
            for (const key in require.cache) {

                // don't invalidate cached modules from node_modules ...
                if (key.match(/node_modules/)) {
                    continue;
                }

                // if an array is provided to the serverless config, check the entries there too
                if (Array.isArray(this.serverless.config.skipCacheInvalidation) &&
                    this.serverless.config.skipCacheInvalidation.find(pattern => new RegExp(pattern).test(key))) {
                    continue;
                }

                delete require.cache[key];
            }
        }

        this.debug(process.cwd());
        const handlerFnNameIndex = fn.handler.lastIndexOf(".");
        const handlerPath = fn.handler.substring(0, handlerFnNameIndex);
        const handlerFnName = fn.handler.substring(handlerFnNameIndex + 1);
        const fullHandlerPath = resolve(this.location, handlerPath);
        this.debug("require(" + fullHandlerPath + ")[" + handlerFnName + "]");
        const handler = require(fullHandlerPath)[handlerFnName];
        return handler;
    }

    public log(msg, prefix = "INFO[serverless-offline-sns]: ") {
        this.serverless.cli.log.call(this.serverless.cli, prefix + msg);
    }

    public debug(msg, context?: string) {
        if (this.config.debug) {
            if (context) {
                this.log(msg, `DEBUG[serverless-offline-sns][${context}]: `);
            } else {
                this.log(msg, "DEBUG[serverless-offline-sns]: ");
            }
        }
    }

    public async listen() {
        this.debug("starting plugin");
        let host = "127.0.0.1";
        if (this.config.host) {
            this.debug(`using specified host ${this.config.host}`);
            host = this.config.host;
        } else if (this.options.host) {
            this.debug(`using offline specified host ${this.options.host}`);
            host = this.options.host;
        }
        return new Promise(res => {
            this.server = this.app.listen(this.port, host, () => {
                this.debug(`listening on ${host}:${this.port}`);
                res();
            });
        });
    }

    public async stop() {
        this.init();
        this.debug("stopping plugin");
        if (this.server) {
            this.server.close();
        }
    }
}

module.exports = ServerlessOfflineSns;
