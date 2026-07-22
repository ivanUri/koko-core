/**
 * hotmail-register.js
 * Đăng ký tài khoản Hotmail sử dụng Chroma standalone (không cần Kameleo Desktop).
 * Phù hợp với cấu trúc của update_manager.js.
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const KameleoHubServer = require('./kameleo-hub');

// ─── CẤU HÌNH ĐƯỜNG DẪN ───────────────────────────────────────────────────────
const CHROMA_PATH = path.join(
    __dirname,
    'chroma-146-osx-arm64-2026_03_26T07_16/browser/Chroma.app/Contents/MacOS/Chroma'
);
const EXTENSION_PATH = path.join(__dirname, 'q2zu3qe0.zyy');
const BASE_WORKSPACE = path.join(__dirname, 'profiles');
const SUCCESS_FILE = path.join(__dirname, 'success_accounts.txt');

// ─── HELPER: Dữ liệu ngẫu nhiên ───────────────────────────────────────────────
function generateRandomData() {
    const firstNames = ["James", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles", "Christopher", "Daniel", "Matthew", "Anthony", "Mark", "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kevin", "Brian", "Isabella", "Sophia", "Emma", "Olivia"];
    const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White", "Harris"];

    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let password = "";
    for (let i = 0; i < 10; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    password += "!@#123";

    const birthYear = Math.floor(Math.random() * (2004 - 1985 + 1)) + 1985;
    const birthMonth = Math.floor(Math.random() * 12) + 1;
    const birthDay = Math.floor(Math.random() * 28) + 1;

    return { firstName, lastName, password, birthYear, birthMonth, birthDay };
}

async function isChromeRunning(port) {
    try {
        await axios.get(`http://127.0.0.1:${port}/json/version`, { timeout: 1000 });
        return true;
    } catch {
        return false;
    }
}

async function findFreePort(start = 40000) {
    const net = require('net');
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(findFreePort(start + 1)));
        server.listen(start, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// ─── LAUNCH CHROMA ────────────────────────────────────────────────────────────
async function launchChroma(account, hubPort) {
    const { name, cdpPort, proxy } = account;

    const workspacePath = path.join(BASE_WORKSPACE, name);
    const browserDataPath = path.join(workspacePath, 'browser');
    fs.mkdirSync(browserDataPath, { recursive: true });

    if (await isChromeRunning(cdpPort)) {
        console.log(`[${name}] Trình duyệt đã chạy sẵn ở cổng ${cdpPort}.`);
        return { endpoint: `http://127.0.0.1:${cdpPort}`, pid: null };
    }

    const proxyBypassList = `127.0.0.1:${hubPort};localhost:${hubPort}`;

    const args = [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${browserDataPath}`,
        `--kpp=${workspacePath}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--use-mock-keychain',
        `--proxy-bypass-list=${proxyBypassList}`,
        '--disable-background-networking',
        '--disable-backgrounding-occluded-windows',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--no-service-autorun',
    ];

    if (proxy) {
        try {
            const url = new URL(proxy);
            args.push(`--proxy-server=${url.host}`);
        } catch (e) {
            const hostPort = proxy.includes('@') ? proxy.split('@')[1] : proxy;
            args.push(`--proxy-server=${hostPort}`);
        }
    }

    const proc = spawn(CHROMA_PATH, args, {
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
    });

    let retries = 40;
    while (retries--) {
        if (await isChromeRunning(cdpPort)) {
            return { endpoint: `http://127.0.0.1:${cdpPort}`, pid: proc.pid };
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`[${name}] Timeout không thể mở Chroma.`);
}

// ─── TASK CHÍNH: ĐĂNG KÝ HOTMAIL ───────────────────────────────────────────────
async function runTask(account) {
    const { name, proxy } = account;
    const profileId = `standalone-${name}`;
    const hubPort = await findFreePort(40000);
    const hub = new KameleoHubServer(hubPort);
    const accountData = generateRandomData();

    let browserInstance = null;
    let browser = null;

    await hub.start();

    try {
        browserInstance = await launchChroma(account, hubPort);
        browser = await chromium.connectOverCDP(browserInstance.endpoint);
        const context = browser.contexts()[0];

        // 📱 Cấu hình Mobile View nếu là profile mobile
        if (account.isMobile) {
            console.log(`[${getTs()}][${name}] 📱 Đang thiết lập Viewport Mobile (375x812)...`);
            await context.setViewportSize({ width: 375, height: 812 });
        }

        // 🟢 Cấu hình Xác thực Proxy
        if (proxy && proxy.includes('@')) {
            const url = new URL(proxy);
            const { username, password } = url;
            if (username && password) {
                context.on('authenticate', async (route) => {
                    await route.continue({ username, password });
                });
            }
        }

        // Tiêm cookie cấu hình cho extension
        const cookieValue = JSON.stringify([hubPort, profileId]);
        await context.addCookies([{
            name: 'KameleoExtensionSettings',
            value: cookieValue,
            domain: 'localhost',
            path: '/',
            secure: false,
            httpOnly: false,
            sameSite: 'Lax',
        }]);

        // Đợi hub đăng ký (giả sử registration xong nhanh)
        await new Promise(r => setTimeout(r, 5000));

        const page = context.pages()[0] || await context.newPage();

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const random = (min, max) => Math.random() * (max - min) + min;
        const smartClick = async (selector, label = "") => {
            const loc = page.locator(selector).first();
            if (label) console.log(`[${getTs()}][${name}] Đang chờ nút: ${label}...`);
            await loc.waitFor({ state: 'visible', timeout: 30000 });
            await sleep(random(800, 1500));
            await loc.scrollIntoViewIfNeeded();
            if (label) console.log(`[${getTs()}][${name}] Đang nhấn: ${label}`);
            await loc.click({ force: true });
        };

        const getTs = () => new Date().toLocaleTimeString();
        const SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"], #idSIButton9, button[data-testid="primaryButton"], button:has-text("Next"), button:has-text("Submit"), button:has-text("Tiếp theo")';

        console.log(`[${getTs()}][${name}] 🟢 Start: Đăng ký Hotmail cho ${accountData.firstName}...`);
        await page.goto("https://signup.live.com/?lic=1", { waitUntil: "domcontentloaded", timeout: 60000 });

        await sleep(5000);



        // --- Bước 1: Nhập Email ---
        const randomSuffix = Math.floor(Math.random() * 10000000);
        const fullEmail = `${accountData.firstName.toLowerCase()}${accountData.lastName.toLowerCase()}${randomSuffix}@outlook.com`;

        console.log(`[${getTs()}][${name}] 📧 Bước 1: Nhập Email [${fullEmail}]`);
        const emailInput = page.locator('input[type="email"], input[name="MemberName"]').first();
        await emailInput.waitFor({ state: 'visible' });
        await emailInput.click();
        await page.keyboard.type(fullEmail, { delay: random(80, 150) });
        await sleep(2000);
        await smartClick(SUBMIT_SELECTOR, "Next (Email)");

        // --- Bước 2: Mật khẩu ---
        console.log(`[${getTs()}][${name}] 🔑 Bước 2: Nhập Mật khẩu`);
        const pwdInput = page.locator('input[name="Password"], input[type="password"]').first();
        await pwdInput.waitFor({ state: 'visible' });
        await sleep(2000);
        await page.keyboard.type(accountData.password, { delay: random(100, 200) });
        await sleep(2000);
        await smartClick(SUBMIT_SELECTOR, "Next (Password)");

        // --- Bước 3: Quốc gia & Ngày sinh ---
        console.log(`[${getTs()}][${name}] 📅 Bước 3: Cấu hình Quốc gia & Ngày sinh`);
        await sleep(3000);
        // 1. Chọn Quốc gia (Nếu có dropdown)
        const countryBtn = page.locator('#countryDropdownId, [name="countryDropdownName"]').first();
        if (await countryBtn.isVisible()) {
            console.log(`[${getTs()}][${name}]   - Đang kiểm tra Quốc gia...`);
            await countryBtn.click({ force: true });
            await sleep(1000);
            await page.keyboard.press('Enter'); // Giữ mặc định (thường là Vietnam theo Proxy)
            await sleep(1000);
        }
        await sleep(3000);
        console.log(`[${getTs()}][${name}]   - Đang chọn Tháng [${accountData.birthMonth}]...`);
        const monthBtn = page.locator('#BirthMonthDropdown, [name="BirthMonth"]').first();
        await monthBtn.waitFor({ state: 'visible', timeout: 30000 });
        await monthBtn.click({ force: true }); // Dùng force để tránh label che
        await sleep(1000);
        await page.keyboard.press('Home');
        await sleep(500);
        for (let i = 1; i < accountData.birthMonth; i++) {
            await page.keyboard.press('ArrowDown');
        }
        await page.keyboard.press('Enter');
        await sleep(1000);

        console.log(`[${getTs()}][${name}]   - Đang chọn Ngày [${accountData.birthDay}]...`);
        const dayBtn = page.locator('#BirthDayDropdown, [name="BirthDay"]').first();
        await dayBtn.click({ force: true });
        await sleep(1000);
        await page.keyboard.press('Home');
        await sleep(500);
        for (let i = 1; i < accountData.birthDay; i++) {
            await page.keyboard.press('ArrowDown');
        }
        await page.keyboard.press('Enter');
        await sleep(1000);

        console.log(`[${getTs()}][${name}]   - Đang nhập Năm [${accountData.birthYear}]...`);
        const yearInput = page.locator('input[name="BirthYear"], #floatingLabelInput24').first();
        await yearInput.waitFor({ state: 'visible' });
        await yearInput.fill(accountData.birthYear.toString());
        await sleep(1000);
        await smartClick(SUBMIT_SELECTOR, "Next (Birthdate)");

        // --- Bước 4: Họ tên ---
        console.log(`[${getTs()}][${name}] 👤 Bước 4: Nhập Họ tên [${accountData.firstName} ${accountData.lastName}]`);
        const fNameInput = page.locator('#firstNameInput, [name="firstNameInput"]').first();
        await fNameInput.waitFor({ state: 'visible' });
        await fNameInput.fill(accountData.firstName);
        await sleep(1000);

        const lNameInput = page.locator('#lastNameInput, [name="lastNameInput"]').first();
        await lNameInput.waitFor({ state: 'visible' });
        await lNameInput.fill(accountData.lastName);
        await sleep(2000);
        await smartClick(SUBMIT_SELECTOR, "Next (Name)");

        // --- Bước 5: Captcha & Hoàn tất ---
        console.log(`[${getTs()}][${name}] Đang chờ bước giải Captcha (Giới hạn 3 phút)...`);

        const captchaStartTime = Date.now();
        const CAPTCHA_TOTAL_TIMEOUT = 180000; // 3 phút tổng cộng cho captcha

        // Thử click giữ Captcha cơ bản
        await sleep(7000);
        try {
            const iframeLoc = page.locator('iframe[data-testid="humanCaptchaIframe"]').first();
            if (await iframeLoc.isVisible({ timeout: 15000 })) {
                const box = await iframeLoc.boundingBox();
                if (box) {
                    console.log(`[${getTs()}][${name}] 🤖 Đang thử click giữ Captcha...`);
                    const centerX = box.x + box.width / 2;
                    const centerY = box.y + box.height / 2;
                    await page.mouse.move(centerX, centerY);
                    await sleep(1000);
                    await page.mouse.down();
                    await sleep(12000); // Giữ 12 giây
                    await page.mouse.up();
                }
            }
        } catch (e) {
            console.log(`[${name}] Iframe Captcha không xuất hiện hoặc đã tự qua.`);
        }

        // Đợi chuyển trang thành công
        try {
            await page.waitForURL((url) => !url.href.includes('signup.live.com'), { timeout: CAPTCHA_TOTAL_TIMEOUT });
            console.log(`[${getTs()}][${name}] ✅ ĐĂNG KÝ THÀNH CÔNG: ${fullEmail}`);

            const resultLine = `${fullEmail}|${accountData.password}|${accountData.firstName}|${accountData.lastName}|${accountData.birthDay}/${accountData.birthMonth}/${accountData.birthYear}\n`;
            fs.appendFileSync(SUCCESS_FILE, resultLine);

            // Lưu vào meta profile
            const metaPath = path.join(BASE_WORKSPACE, name, 'meta.json');
            const meta = JSON.parse(fs.readFileSync(metaPath));
            meta.hotmail = fullEmail;
            meta.password = accountData.password;
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        } catch (e) {
            console.log(`[${name}] ❌ Hết thời gian chờ Captcha (3p). Đang đóng để thử nick khác.`);
            throw new Error("Captcha Timeout");
        }

    } catch (error) {
        console.error(`[${name}] 🛑 Lỗi hệ thống:`, error.message);
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (e) { }
        }
        if (browserInstance && browserInstance.pid) {
            try {
                process.kill(browserInstance.pid);
                console.log(`[${name}] 🏁 Đã kill tiến trình Chroma (PID: ${browserInstance.pid})`);
            } catch (e) { }
        }
        await hub.stop();
        console.log(`[${name}] Hub đã dừng.`);
    }
}

// ─── ĐỌC ACCOUNTS TỪ PROFILES ──────────────────────────────────────────────
function loadAccounts() {
    if (!fs.existsSync(BASE_WORKSPACE)) {
        console.error('Chưa có profiles! Hãy chạy: node create_profile.js');
        process.exit(1);
    }
    return fs.readdirSync(BASE_WORKSPACE, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('profile_'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map((dir, i) => {
            const metaPath = path.join(BASE_WORKSPACE, dir.name, 'meta.json');
            const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : {};
            return {
                name: dir.name,
                cdpPort: 9001 + i,
                proxy: meta.proxy || null,
                isMobile: meta.isMobile || false,
            };
        });
}

const accounts = loadAccounts();
const MAX_CONCURRENT_PROFILES = 10;
const START_FROM_INDEX = 13; // Bắt đầu từ profile số mấy (0 là từ đầu)

(async () => {
    const filteredAccounts = accounts.slice(START_FROM_INDEX);
    console.log(`=== BẮT ĐẦU ĐĂNG KÝ HOTMAIL CHROMA (MAX: ${MAX_CONCURRENT_PROFILES}, START: ${START_FROM_INDEX}) ===`);

    const queue = [...filteredAccounts];
    const activeTasks = new Set();
    const results = [];

    async function handleNext() {
        if (queue.length === 0) return;

        const account = queue.shift();
        const taskPromise = runTask(account);
        activeTasks.add(taskPromise);

        console.log(`\n[Hàng đợi] Bắt đầu: ${account.name} (Đang chạy: ${activeTasks.size}/${MAX_CONCURRENT_PROFILES})`);

        await taskPromise;
        activeTasks.delete(taskPromise);

        // Ngay khi xong 1 cái, gọi cái tiếp theo
        if (queue.length > 0) {
            await handleNext();
        }
    }

    // Khởi tạo các thread ban đầu
    const initialThreads = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENT_PROFILES, queue.length); i++) {
        initialThreads.push(handleNext());
    }

    await Promise.all(initialThreads);

    console.log('\n=== HOÀN THÀNH TẤT CẢ ===');
})();