import 'promise-polyfill/src/polyfill';

import Notice from './notice';
import FuncWrapper from './func_wrapper';

import Processor from './processor/processor';
import stacktracejsProcessor from './processor/stacktracejs';

import Filter from './filter/filter';
import ignoreFilter from './filter/ignore';
import makeDebounceFilter from './filter/debounce';
import uncaughtMessageFilter from './filter/uncaught_message';
import angularMessageFilter from './filter/angular_message';
import windowFilter from './filter/window';
import nodeFilter from './filter/node';
import makeBlacklistFilter from './filter/blacklist';

import {Reporter, ReporterOptions} from './reporter/reporter';
import fetchReporter from './reporter/fetch';

import {historian, getHistory} from './historian';


declare const VERSION: string;


interface Todo {
    err: any;
    resolve: (Notice) => void;
    reject: (Error) => void;
}


class Client {
    private opts: ReporterOptions = {} as ReporterOptions;

    private processor: Processor;
    private reporter: Reporter;
    private filters: Filter[] = [];

    private offline = false;
    private todo: Todo[] = [];

    private onClose: (() => void)[] = [];

    constructor(opts: any = {}) {
        if (!opts.projectId || !opts.projectKey) {
            throw new Error('airbrake: projectId and projectKey are required');
        }

        this.opts = opts;
        this.opts.host = this.opts.host || 'https://api.airbrake.io';
        this.opts.timeout = this.opts.timeout || 10000;

        this.processor = opts.processor || stacktracejsProcessor;
        this.setReporter();

        this.addFilter(ignoreFilter);
        this.addFilter(makeDebounceFilter());
        this.addFilter(uncaughtMessageFilter);
        this.addFilter(angularMessageFilter);

        let keysBlacklist = opts.keysBlacklist || [
            /password/,
            /secret/,
        ];
        this.addFilter(makeBlacklistFilter(keysBlacklist));

        if (opts.environment) {
            this.addFilter((notice: Notice): Notice | null => {
                notice.context.environment = opts.environment;
                return notice;
            });
        }

        if (typeof window === 'object') {
            this.addFilter(windowFilter);

            if (window.addEventListener) {
                this.onOnline = this.onOnline.bind(this);
                window.addEventListener('online', this.onOnline);
                this.onOffline = this.onOffline.bind(this);
                window.addEventListener('offline', this.onOffline);

                this.onUnhandledrejection = this.onUnhandledrejection.bind(this);
                window.addEventListener(
                    'unhandledrejection', this.onUnhandledrejection);

                this.onClose.push(() => {
                    window.removeEventListener('online', this.onOnline);
                    window.removeEventListener('offline', this.onOffline);
                    window.removeEventListener(
                        'unhandledrejection', this.onUnhandledrejection);
                });
            }
        } else {
            this.addFilter(nodeFilter);
        }

        historian.registerNotifier(this);
        if (opts.unwrapConsole || isDevEnv(opts)) {
            historian.unwrapConsole();
        }
    }

    close(): void {
        for (let fn of this.onClose) {
            fn();
        }
        historian.unregisterNotifier(this);
    }

    private setReporter(): void {
        this.reporter = fetchReporter;
    }

    addFilter(filter: Filter): void {
        this.filters.push(filter);
    }

    notify(err: any): Promise<Notice> {
        let notice: Notice = {
            id: '',
            errors: [],
            context: Object.assign({
                severity: 'error'
            }, err.context),
            params: err.params || {},
            environment: err.environment || {},
            session: err.session || {},
        };

        if (typeof err !== 'object' || err.error === undefined) {
            err = {error: err};
        }

        if (!err.error) {
            notice.error = new Error(
                `airbrake: got err=${JSON.stringify(err.error)}, wanted an Error`);
            return Promise.resolve(notice);
        }

        if (this.opts.ignoreWindowError && err.context && err.context.windowError) {
            notice.error = new Error('airbrake: window error is ignored');
            return Promise.resolve(notice);
        }

        if (this.offline) {
            return new Promise((resolve, reject) => {
                this.todo.push({
                    err: err,
                    resolve: resolve,
                    reject: reject,
                });
                while (this.todo.length > 100) {
                    let j = this.todo.shift();
                    if (j === undefined) {
                        break;
                    }
                    notice.error = new Error('airbrake: offline queue is too large');
                    j.resolve(notice);
                }
            });
        }

        let history = getHistory();
        if (history.length > 0) {
            notice.context.history = history;
        }

        let error = this.processor(err.error);
        notice.errors.push(error);

        for (let filter of this.filters) {
            let r = filter(notice);
            if (r === null) {
                notice.error = new Error('airbrake: error is filtered');
                return Promise.resolve(notice);
            }
            notice = r;
        }

        if (!notice.context) {
            notice.context = {};
        }
        notice.context.language = 'JavaScript';
        notice.context.notifier = {
            name: 'airbrake-js',
            version: VERSION,
            url: 'https://github.com/airbrake/airbrake-js'
        };

        return this.reporter(notice, this.opts);
    }

    // TODO: fix wrapping for multiple clients
    wrap(fn, props: string[] = []): FuncWrapper {
        if (fn._airbrake) {
            return fn;
        }

        let client = this;
        let airbrakeWrapper = function () {
            let fnArgs = Array.prototype.slice.call(arguments);
            let wrappedArgs = client.wrapArguments(fnArgs);
            try {
                return fn.apply(this, wrappedArgs);
            } catch (err) {
                client.notify({error: err, params: {arguments: fnArgs}});
                historian.ignoreNextWindowError();
                throw err;
            }
        } as FuncWrapper;

        for (let prop in fn) {
            if (fn.hasOwnProperty(prop)) {
                airbrakeWrapper[prop] = fn[prop];
            }
        }
        for (let prop of props) {
            if (fn.hasOwnProperty(prop)) {
                airbrakeWrapper[prop] = fn[prop];
            }
        }

        airbrakeWrapper._airbrake = true;
        airbrakeWrapper.inner = fn;

        return airbrakeWrapper;
    }

    private wrapArguments(args: any[]): any[] {
        for (let i in args) {
            let arg = args[i];
            if (typeof arg === 'function') {
                args[i] = this.wrap(arg);
            }
        }
        return args;
    }

    call(fn, ..._args: any[]): any {
        let wrapper = this.wrap(fn);
        return wrapper.apply(this, Array.prototype.slice.call(arguments, 1));
    }

    onerror(): void {
        historian.onerror.apply(historian, arguments);
    }

    private onOnline(): void {
        this.offline = false;

        for (let j of this.todo) {
            this.notify(j.err).then((notice) => {
                j.resolve(notice);
            });
        }
        this.todo = [];
    }

    private onOffline(): void {
        this.offline = true;
    }

    private onUnhandledrejection(e: PromiseRejectionEvent | CustomEvent): void {
        // Handle native or bluebird Promise rejections
        // https://developer.mozilla.org/en-US/docs/Web/Events/unhandledrejection
        // http://bluebirdjs.com/docs/api/error-management-configuration.html
        let reason = (<PromiseRejectionEvent>e).reason || (<CustomEvent>e).detail.reason;
        let msg = reason.message || String(reason);
        if (msg.indexOf && msg.indexOf('airbrake: ') === 0) {
            return;
        }
        this.notify(reason);
    }
}

function isDevEnv(opts: any): boolean {
    let env = opts.environment;
    return env && env.startsWith && env.startsWith('dev');
}

export = Client;
