// tests/freeze.spec.js
const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result) {
    return new Promise((resolve) => {

        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置');
            return resolve();
        }

        const msg = [
            `🎮 FreezeHost 续期通知`,
            `🕐 时间: ${nowStr()}`,
            `📊 结果: ${result}`
        ].join('\n');

        const body = JSON.stringify({
            chat_id: TG_CHAT_ID,
            text: msg
        });

        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) {
                console.log('📨 TG 推送成功');
            } else {
                console.log(`⚠️ TG 推送失败 HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

async function handleOAuthPage(page) {

    const selectors = [
        'button:has-text("Authorize")',
        'button:has-text("授权")',
        'button[type="submit"]'
    ];

    for (let i = 0; i < 8; i++) {

        if (!page.url().includes('discord.com')) {
            return;
        }

        for (const selector of selectors) {

            try {

                const btn = page.locator(selector).last();

                if (!(await btn.isVisible())) continue;

                const text = (await btn.innerText()).trim();

                if (text.toLowerCase().includes('cancel')) continue;

                await btn.click();
                await page.waitForTimeout(2000);

                if (!page.url().includes('discord.com')) return;

            } catch {}
        }

        await page.waitForTimeout(2000);
    }
}

test('FreezeHost 自动续期', async () => {

    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) {
        throw new Error('❌ DISCORD_ACCOUNT 未配置');
    }

    console.log('🔧 启动浏览器...');

    const browser = await chromium.launch({
        headless: true
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {

        console.log('🌐 验证出口 IP');

        try {
            const res = await page.goto('https://api.ipify.org?format=json');
            const body = await res.text();
            const ip = JSON.parse(body).ip;
            console.log(`✅ 当前 IP ${ip}`);
        } catch {}

        console.log('🔑 打开 FreezeHost');

        await page.goto('https://free.freezehost.pro');

        console.log('📤 点击 Discord 登录');

        await page.click('span:has-text("Login with Discord")');

        const confirmBtn = page.locator('#confirm-login');
        await confirmBtn.waitFor();
        await confirmBtn.click();

        await page.waitForURL(/discord\.com\/login/);

        console.log('✏️ 填写账号');

        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);

        await page.click('button[type="submit"]');

        await page.waitForTimeout(2000);

        if (page.url().includes('discord.com/oauth2')) {

            console.log('🔑 处理 OAuth');

            await handleOAuthPage(page);
        }

        console.log('⏳ 等待 Dashboard');

        await page.waitForURL(/freezehost/, { timeout: 20000 });

        console.log(`✅ 当前页面 ${page.url()}`);

        if (!page.url().includes('dashboard')) {
            await page.goto('https://free.freezehost.pro/dashboard');
        }

        console.log('🔍 查找服务器 Console');

        await page.waitForTimeout(3000);

        const consoleUrl = await page.evaluate(() => {

            const link =
                document.querySelector('a[href*="server-console"]') ||
                document.querySelector('a[href*="console"]');

            return link ? link.href : null;
        });

        if (!consoleUrl) {
            throw new Error('❌ 未找到服务器 console');
        }

        console.log(`✅ console: ${consoleUrl}`);

        await page.goto(consoleUrl);

        await page.waitForTimeout(4000);

        console.log('🔍 检查剩余时间');

        const renewalText = await page.evaluate(() => {
            const el = document.getElementById('renewal-status-console');
            return el ? el.innerText : null;
        });

        console.log(`📋 状态: ${renewalText}`);

        if (renewalText) {

            const match = renewalText.match(/(\d+(?:\.\d+)?)\s*day/i);

            if (match) {

                const days = parseFloat(match[1]);

                console.log(`⏳ 剩余 ${days} 天`);

                if (days > 7) {

                    const msg = `⏰ 剩余 ${days} 天，无需续期`;
                    console.log(msg);
                    await sendTG(msg);
                    return;
                }
            }
        }

        console.log('🔍 查找 Renew 按钮');

        const renewLink = await page.evaluate(() => {

            const aTags = [...document.querySelectorAll('a')];

            const renew = aTags.find(a =>
                a.innerText.toLowerCase().includes('renew')
            );

            return renew ? renew.href : null;
        });

        if (!renewLink) {
            throw new Error('❌ 未找到 Renew 链接');
        }

        const renewAbsUrl = new URL(renewLink, page.url()).href;

        console.log(`📤 进入续期 ${renewAbsUrl}`);

        await page.goto(renewAbsUrl);

        await page.waitForURL(url =>
            url.toString().includes('dashboard') ||
            url.toString().includes('server-console'),
            { timeout: 30000 }
        );

        const finalUrl = page.url();

        if (finalUrl.includes('success=RENEWED')) {

            console.log('🎉 续期成功');
            await sendTG('✅ 续期成功');

        } else if (finalUrl.includes('CANNOTAFFORD')) {

            console.log('⚠️ 余额不足');
            await sendTG('⚠️ FreezeHost 余额不足');

        } else if (finalUrl.includes('TOOEARLY')) {

            console.log('⏰ 未到续期时间');
            await sendTG('⏰ 未到续期时间');

        } else {

            console.log(`⚠️ 未知状态 ${finalUrl}`);
            await sendTG(`⚠️ 未知结果 ${finalUrl}`);
        }

    } catch (e) {

        console.log(`❌ 脚本异常 ${e.message}`);
        await sendTG(`❌ 脚本异常 ${e.message}`);
        throw e;

    } finally {

        await browser.close();
    }
});