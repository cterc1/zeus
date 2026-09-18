'use strict';

const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const https = require('https');
const axios = require('axios');

const HOST = 'api.crypto.com';
const PORT = 443;
const BASE = 'https://api.crypto.com/dcm/v1';
const TIMEOUT_MS = 8000;

function elapsed(start) {
    return `${Date.now() - start}ms`;
}

async function dnsTest() {
    console.log('\n[1/4] DNS');
    const start = Date.now();
    try {
        const all = await dns.lookup(HOST, { all: true });
        console.log(`PASS ${elapsed(start)}`);
        console.log(JSON.stringify(all, null, 2));
        return all;
    } catch (error) {
        console.log(`FAIL ${elapsed(start)} code=${error.code || 'NONE'} message=${error.message}`);
        return [];
    }
}

function tcpTest(address) {
    return new Promise(resolve => {
        console.log(`\n[2/4] TCP IPv4 ${address}:${PORT}`);
        const start = Date.now();
        const socket = net.createConnection({ host: address, port: PORT, family: 4 });
        let done = false;

        function finish(ok, detail) {
            if (done) return;
            done = true;
            socket.destroy();
            console.log(`${ok ? 'PASS' : 'FAIL'} ${elapsed(start)} ${detail}`);
            resolve(ok);
        }

        socket.setTimeout(TIMEOUT_MS);
        socket.once('connect', () => finish(true, 'connected'));
        socket.once('timeout', () => finish(false, 'timeout'));
        socket.once('error', error =>
            finish(false, `code=${error.code || 'NONE'} message=${error.message}`)
        );
    });
}

function tlsTest(address) {
    return new Promise(resolve => {
        console.log(`\n[3/4] TLS IPv4 ${address}:${PORT}`);
        const start = Date.now();
        const socket = tls.connect({
            host: address,
            port: PORT,
            family: 4,
            servername: HOST,
            rejectUnauthorized: true
        });
        let done = false;

        function finish(ok, detail) {
            if (done) return;
            done = true;
            socket.destroy();
            console.log(`${ok ? 'PASS' : 'FAIL'} ${elapsed(start)} ${detail}`);
            resolve(ok);
        }

        socket.setTimeout(TIMEOUT_MS);
        socket.once('secureConnect', () =>
            finish(true, `authorized=${socket.authorized} protocol=${socket.getProtocol()}`)
        );
        socket.once('timeout', () => finish(false, 'timeout'));
        socket.once('error', error =>
            finish(false, `code=${error.code || 'NONE'} message=${error.message}`)
        );
    });
}

async function httpTest() {
    console.log('\n[4/4] DCM HTTPS GET forced IPv4');
    const start = Date.now();
    const agent = new https.Agent({
        family: 4,
        keepAlive: false
    });

    try {
        const response = await axios.get(`${BASE}/public/get-instruments`, {
            params: {
                inst_type: 'BINARY_OPTION',
                limit: 1
            },
            timeout: TIMEOUT_MS,
            httpsAgent: agent,
            headers: {
                Accept: 'application/json'
            },
            validateStatus: () => true
        });

        console.log(`PASS ${elapsed(start)} HTTP=${response.status}`);
        console.log(`CryptoCode=${response.data?.code ?? 'NONE'} Message=${response.data?.message ?? 'NONE'}`);
        return true;
    } catch (error) {
        console.log(
            `FAIL ${elapsed(start)} code=${error.code || 'NONE'} ` +
            `HTTP=${error.response?.status ?? 'NONE'} message=${error.message}`
        );
        return false;
    } finally {
        agent.destroy();
    }
}

async function main() {
    console.log('==================================================');
    console.log(' ZEUS RENDER -> CRYPTO.COM DCM NETWORK DIAGNOSTIC');
    console.log('==================================================');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Node: ${process.version}`);
    console.log(`Host: ${HOST}`);
    console.log('READ-ONLY. NO ORDER/TRADING ACTIONS.');

    const addresses = await dnsTest();
    const ipv4 = addresses.filter(item => item.family === 4);

    if (!ipv4.length) {
        console.log('\nRESULT: DNS returned no IPv4 address. Stop here.');
        process.exitCode = 2;
        return;
    }

    // Test up to two addresses so one bad edge address does not mislead us.
    for (const item of ipv4.slice(0, 2)) {
        await tcpTest(item.address);
        await tlsTest(item.address);
    }

    const httpOk = await httpTest();

    console.log('\n==================================================');
    console.log(' DIAGNOSTIC COMPLETE');
    console.log('==================================================');
    console.log(
        httpOk
            ? 'RESULT: Render received an HTTP response from Crypto.com DCM.'
            : 'RESULT: Render did not receive an HTTP response from Crypto.com DCM.'
    );
}

main().catch(error => {
    console.error('FATAL:', error);
    process.exitCode = 1;
});
