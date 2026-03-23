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
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }

        const msg = [
            `🎮 FreezeHost 续期通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: FreezeHost Free`,
            `📊 续期结果: ${result}`,
        ].join('\n');

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });

        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) console.log('📨 TG 推送成功');
            else console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            resolve();
        });

        req.on('error', (e) => { console.log(`⚠️ TG 推送异常：${e.message}`); resolve(); });
        req.setTimeout(15000, () => { console.log('⚠️ TG 推送超时'); req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
}

// Discord OAuth 授权页处理
async function handleOAuthPage(page) {
    console.log(`  📄 当前 URL: ${page.url()}`);
    await page.waitForTimeout(3000);

    const selectors = [
        'button:has-text("Authorize")',
        'button:has-text("授权")',
        'button[type="submit"]',
        'div[class*="footer"] button',
        'button[class*="primary"]',
    ];

    for (let i = 0; i < 8; i++) {
        console.log(`  🔄 第 ${i + 1} 次尝试，URL: ${page.url()}`);
        if (!page.url().includes('discord.com')) return;

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);

        for (const selector of selectors) {
            try {
                const btn = page.locator(selector).last();
                if (!(await btn.isVisible())) continue;

                const text = (await btn.innerText()).trim();
                if (text.includes('取消') || text.toLowerCase().includes('cancel') || text.toLowerCase().includes('deny')) continue;

                if (await btn.isDisabled()) break;

                await btn.click();
                console.log(`  ✅ 已点击: "${text}"`);
                await page.waitForTimeout(2000);

                if (!page.url().includes('discord.com')) return;
                break;
            } catch { continue; }
        }

        await page.waitForTimeout(2000);
    }
    console.log(`  ⚠️ handleOAuthPage 结束，URL: ${page.url()}`);
}

test('FreezeHost 自动续期', async () => {
    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) throw new Error('❌ 缺少 DISCORD_ACCOUNT，格式: email,password');

    let proxyConfig;
    if (process.env.GOST_PROXY) {
        try {
            const http = require('http');
            await new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 }, resolve);
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: process.env.GOST_PROXY };
            console.log('🛡️ 本地代理连通，使用 GOST 转发');
        } catch { console.log('⚠️ 本地代理不可达，降级为直连'); }
    }

    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    console.log('🚀 浏览器就绪！');

    try {
        // 出口 IP 验证
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const ip = JSON.parse(await res.text()).ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
            console.log(`✅ 出口 IP 确认：${ip}`);
        } catch { console.log('⚠️ IP 验证超时，跳过'); }

        // 登录 FreezeHost
        console.log('🔑 打开 FreezeHost 登录页...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
        console.log('📤 点击 Login with Discord...');
        await page.click('span.text-lg:has-text("Login with Discord")');

        console.log('⏳ 等待服务条款弹窗...');
        const confirmBtn = page.locator('button#confirm-login');
        await confirmBtn.waitFor({ state: 'visible' });
        await confirmBtn.click();
        console.log('✅ 已接受服务条款');

        console.log('⏳ 等待 Discord 登录页...');
        await page.waitForURL(/discord\.com\/login/);

        console.log('✏️ 填写账号密码...');
        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);
        await page.click('button[type="submit"]');
        await page.waitForTimeout(2000);

        if (/discord\.com\/login/.test(page.url())) {
            let err = '账密错误或触发了 2FA / 验证码';
            try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
            await sendTG(`❌ Discord 登录失败：${err}`);
            throw new Error(`❌ Discord 登录失败: ${err}`);
        }

        // OAuth 授权
        console.log('⏳ 等待 OAuth 授权...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await page.waitForTimeout(2000);
            if (page.url().includes('discord.com')) await handleOAuthPage(page);
            await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
            console.log(`✅ 已离开 Discord，当前：${page.url()}`);
        } catch { console.log(`✅ 静默授权或已跳转，当前：${page.url()}`); }

        // Dashboard
        console.log('⏳ 确认到达 Dashboard...');
        try { await page.waitForURL(url => url.includes('/callback') || url.includes('/dashboard'), { timeout: 10000 }); } catch {}
        if (page.url().includes('/callback')) await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
        if (!page.url().includes('/dashboard')) throw new Error(`❌ 未到达 Dashboard，当前 URL: ${page.url()}`);
        console.log(`✅ 登录成功！当前：${page.url()}`);

        // Server Console
        console.log('🔍 查找 server-console 链接...');
        const serverUrl = await page.evaluate(() => document.querySelector('a[href*="server-console"]')?.href);
        if (!serverUrl) throw new Error('❌ 未找到 server-console 链接');
        await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
        console.log(`✅ 已跳转到 Server Console: ${page.url()}`);

        // 续期状态
        console.log('🔍 读取续期状态...');
        await page.waitForTimeout(2000);
        const renewalStatusText = await page.evaluate(() => document.getElementById('renewal-status-console')?.innerText.trim());
        console.log(`📋 续期状态：${renewalStatusText}`);

        if (renewalStatusText) {
            const daysMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*day/i);
            const remainingDays = daysMatch ? parseFloat(daysMatch[1]) : null;
            if (remainingDays !== null) {
                console.log(`⏳ 剩余天数：${remainingDays}`);
                if (remainingDays > 7) {
                    const msg = `⏰ 剩余 ${remainingDays} 天，无需续期（需 ≤7 天才续期）`;
                    console.log(msg);
                    await sendTG(msg);
                    return;
                }
                console.log(`✅ 剩余 ${remainingDays} 天，需要续期，继续操作...`);
            }
        }

        // 点击 Renewal 信息按钮（稳定版）
        console.log('🔍 点击 Renewal 按钮...');
        const renewTrigger = page.locator('#renew-link-trigger');
        await renewTrigger.waitFor({ state: 'visible', timeout: 15000 });
        await renewTrigger.click();
        console.log('✅ 已点击 Renewal 按钮');

        // 弹窗续期按钮
        const renewModalBtn = page.locator('#renew-link-modal');
        await renewModalBtn.waitFor({ state: 'visible', timeout: 10000 });
        const btnText = (await renewModalBtn.innerText()).trim();
        console.log(`📋 续期按钮文字："${btnText}"`);
        if (!btnText.toLowerCase().includes('renew instance')) {
            console.log('⏰ 尚未到续期时间');
            await sendTG('⏰ 尚未到续期时间，今日已续期或暂不需要续期');
            return;
        }

        // 跳转续期
        const renewHref = await renewModalBtn.getAttribute('href');
        if (!renewHref || renewHref === '#') throw new Error(`❌ renew-link-modal href 无效：${renewHref}`);
        const renewAbsUrl = new URL(renewHref, page.url()).href;
        await page.goto(renewAbsUrl, { waitUntil: 'domcontentloaded' });
        console.log('📤 已跳转 RENEW，等待结果...');

        await page.waitForURL(url => url.toString().includes('/dashboard') || url.toString().includes('/server-console'), { timeout: 30000 });
        const finalUrl = page.url();

        // 续期结果判断
        if (finalUrl.includes('success=RENEWED')) {
            console.log('🎉 续期成功！'); await sendTG('✅ 续期成功！'); expect(finalUrl).toContain('success=RENEWED');
        } else if (finalUrl.includes('err=CANNOTAFFORDRENEWAL')) {
            console.log('⚠️ 余额不足，无法续期'); await sendTG('⚠️ 余额不足，请前往挂机页面赚取金币'); test.skip(true, '余额不足');
        } else if (finalUrl.includes('err=TOOEARLY')) {
            console.log('⏰ 尚未到续期时间，无需操作'); await sendTG('⏰ 尚未到续期时间，今日已续期或暂不需要续期');
        } else { await sendTG(`⚠️ 续期结果未知：${finalUrl}`); throw new Error('续期结果未知，URL: ' + finalUrl); }

    } catch (e) {
        if (!e.message?.includes('余额不足')) await sendTG(`❌ 脚本异常：${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});