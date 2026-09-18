'use strict';

const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const https = require('https');

const HOST = 'api.crypto.com';
const PORT = 443;
const PATH = '/dcm/v1/public/get-instruments?inst_type=BINARY_OPTION&limit=1';
const STEP_TIMEOUT_MS = 8000;

function elapsed(start) {
    return `${Date.now() - start}ms`;
}

function withTimeout(promise, label, timeoutMs = STEP_TIMEOUT_MS) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            const timer = setTimeout(() => {
                const error = new Error(`${label} timed out after ${timeoutMs}ms`);
                error.code = 'DIAGNOSTIC_TIMEOUT';
                reject(error);
            }, timeoutMs);
            timer.unref?.();
        })
    ]);
}

async function testTcp(address) {
    const started = Date.now();

    await withTimeout(new Promise((resolve, reject) => {
        const socket = net.createConnection({
            host: address,
            port: PORT,
            family: 4
        });

        const finish = error => {
            socket.removeAllListeners();
            socket.destroy();
            error ? reject(error) : resolve();
        };

        socket.once('connect', () => finish());
        socket.once('error', finish);
    }), `TCP IPv4 ${address}:${PORT}`);

    return elapsed(started);
}

async function testTls(address) {
    const started = Date.now();

    const result = await withTimeout(new Promise((resolve, reject) => {
        const socket = tls.connect({
            host: address,
            port: PORT,
            family: 4,
            servername: HOST,
            rejectUnauthorized: true
        });

        const finish = (error, value) => {
            socket.removeAllListeners();
            socket.destroy();
            error ? reject(error) : resolve(value);
        };

        socket.once('secureConnect', () => {
            finish(null, {
                authorized: socket.authorized,
                protocol: socket.getProtocol()
            });
        });
        socket.once('error', error => finish(error));
    }), `TLS IPv4 ${address}:${PORT}`);

    return {
        elapsed: elapsed(started),
        ...result
    };
}

async function testHttps() {
    const started = Date.now();

    const result = await withTimeout(new Promise((resolve, reject) => {
        const agent = new https.Agent({
            family: 4,
            keepAlive: false
        });

        const request = https.get({
            hostname: HOST,
            port: PORT,
            path: PATH,
            method: 'GET',
            family: 4,
            agent,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Zeus-DCM-Diagnostic/1.0'
            }
        }, response => {
            let body = '';

            response.setEncoding('utf8');
            response.on('data', chunk => {
                if (body.length < 4000) body += chunk;
            });
            response.on('end', () => {
                agent.destroy();

                let parsed = null;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    // Keep parsed null; HTTP status is still useful.
                }

                resolve({
                    httpStatus: response.statusCode,
                    cryptoCode: parsed?.code ?? null,
                    message: parsed?.message ?? parsed?.msg ?? null
                });
            });
        });

        request.setTimeout(STEP_TIMEOUT_MS, () => {
            request.destroy(new Error(`HTTPS request timed out after ${STEP_TIMEOUT_MS}ms`));
        });
        request.once('error', error => {
            agent.destroy();
            reject(error);
        });
    }), 'DCM HTTPS GET forced IPv4');

    return {
        elapsed: elapsed(started),
        ...result
    };
}

async function runDiagnostic() {
    console.log('');
    console.log('==================================================');
    console.log(' ZEUS RENDER -> CRYPTO.COM DCM NETWORK DIAGNOSTIC');
    console.log('==================================================');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Node: ${process.version}`);
    console.log(`Host: ${HOST}`);
    console.log('READ-ONLY. NO ORDER/TRADING ACTIONS.');
    console.log('');

    let addresses = [];
    let httpResponseReceived = false;

    try {
        const started = Date.now();
        addresses = await withTimeout(
            dns.resolve4(HOST),
            'DNS IPv4 lookup'
        );
        console.log('[1/4] DNS');
        console.log(`PASS ${elapsed(started)}`);
        console.log(JSON.stringify(addresses.map(address => ({ address, family: 4 })), null, 2));
    } catch (error) {
        console.log('[1/4] DNS');
        console.log(`FAIL code=${error.code || 'UNKNOWN'} message=${error.message}`);
    }

    for (const address of addresses.slice(0, 2)) {
        try {
            const timing = await testTcp(address);
            console.log(`\n[2/4] TCP IPv4 ${address}:${PORT}`);
            console.log(`PASS ${timing} connected`);
        } catch (error) {
            console.log(`\n[2/4] TCP IPv4 ${address}:${PORT}`);
            console.log(`FAIL code=${error.code || 'UNKNOWN'} message=${error.message}`);
        }

        try {
            const result = await testTls(address);
            console.log(`\n[3/4] TLS IPv4 ${address}:${PORT}`);
            console.log(`PASS ${result.elapsed} authorized=${result.authorized} protocol=${result.protocol || 'UNKNOWN'}`);
        } catch (error) {
            console.log(`\n[3/4] TLS IPv4 ${address}:${PORT}`);
            console.log(`FAIL code=${error.code || 'UNKNOWN'} message=${error.message}`);
        }
    }

    try {
        const result = await testHttps();
        httpResponseReceived = true;
        console.log('\n[4/4] DCM HTTPS GET forced IPv4');
        console.log(`PASS ${result.elapsed} HTTP=${result.httpStatus}`);
        console.log(`CryptoCode=${result.cryptoCode ?? 'NONE'} Message=${result.message ?? 'NONE'}`);
    } catch (error) {
        console.log('\n[4/4] DCM HTTPS GET forced IPv4');
        console.log(`FAIL code=${error.code || 'UNKNOWN'} message=${error.message}`);
    }

    console.log('');
    console.log('==================================================');
    console.log(' DIAGNOSTIC COMPLETE');
    console.log('==================================================');
    console.log(
        httpResponseReceived
            ? 'RESULT: This host received an HTTP response from Crypto.com DCM.'
            : 'RESULT: This host did NOT receive an HTTP response from Crypto.com DCM.'
    );
    console.log('==================================================');
    console.log('');

    return { httpResponseReceived, addresses };
}

if (require.main === module) {
    runDiagnostic().catch(error => {
        console.error('Diagnostic crashed:', error);
        process.exitCode = 1;
    });
}

module.exports = {
    runDiagnostic
};
