const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { chromium } = require('playwright');

const html = pathToFileURL(path.join(__dirname, '업무 일정 대시보드 v1.3.2.html')).href;
const fixedDate = new Date('2026-11-20T12:00:00+09:00');
const project = (id, name, owner, start, end, status, color, memo = '') =>
  ({ id, name, owner, start, end, status, color, memo });
const task = (id, projectId, name, owner, start, end, status, memo = '') =>
  ({ id, projectId, name, owner, start, end, status, memo });
const legacy = {
  version: '1.3.1',
  projects: [
    project('pilot', '현장 검증 파일럿', '김민서', '2026-11-13', '2026-11-24', '완료', '#4777ed', '1차 현장 검증 결과를 정리했습니다.'),
    project('release', '서비스 개선 2차', '이서준', '2026-11-18', '2026-12-04', '진행', '#18a58c', '화면 및 운영 지표 개선'),
    project('handoff', '운영 인수인계', '박지우', '2026-11-25', '2026-12-08', '대기', '#a46bd5'),
  ],
  tasks: [
    task('checklist', 'pilot', '현장 체크리스트 정리', '김민서', '2026-11-14', '2026-11-17', '완료'),
    task('review', 'pilot', '후속 의견 검토', '김민서', '2026-11-19', '2026-11-24', '진행'),
    task('qa', 'release', 'QA 체크리스트 작성', '이서준', '2026-11-18', '2026-11-20', '완료', '회귀 테스트 범위를 확정했습니다.'),
    task('flow', 'release', '사용자 흐름 확인', '이서준', '2026-11-21', '2026-11-28', '진행'),
  ],
};

function mockSheet(rows) {
  return {
    rows,
    columns: 9,
    maxRows: Math.max(20, rows.length),
    getLastRow() {
      return this.rows.findLastIndex(row => row.some(cell => cell !== '')) + 1;
    },
    getMaxColumns() { return this.columns; },
    getMaxRows() { return this.maxRows; },
    insertColumnsAfter(_after, count) { this.columns += count; },
    insertRowsAfter(_after, count) { this.maxRows += count; },
    setFrozenRows() {},
    getRange(row, col, count, width) {
      assert.ok(col + width - 1 <= this.columns);
      assert.ok(row + count - 1 <= this.maxRows);
      return {
        getValues: () => Array.from({ length: count }, (_, r) =>
          Array.from({ length: width }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? '')),
        setValues: values => {
          assert.equal(col, 1);
          assert.equal(row, 1);
          assert.equal(values.length, count);
          for (const value of values) assert.equal(value.length, width);
          this.rows.splice(0, count, ...structuredClone(values));
        },
        setBackground() {},
        setFontColor() {},
        setFontWeight() {},
        setHorizontalAlignment() {},
      };
    },
  };
}

function mockAppsScript(source, initial) {
  const sheets = new Map([
    ['프로젝트', mockSheet([Array(9).fill('기존 헤더'), ...initial.projects.map(p =>
      [p.id, p.name, p.owner, p.start, p.end, p.status, p.color, p.memo, ''])])],
    ['하위업무', mockSheet([Array(9).fill('기존 헤더'), ...initial.tasks.map(t =>
      [t.id, t.projectId, t.name, t.owner, t.start, t.end, t.status, t.memo, ''])])],
  ]);
  const workbook = {
    getName: () => '테스트용 시트',
    getSheetByName: name => sheets.get(name),
    insertSheet(name) {
      const sheet = mockSheet([]);
      sheets.set(name, sheet);
      return sheet;
    },
  };
  let locked = false;
  const gas = vm.createContext({
    SpreadsheetApp: {
      openById: () => workbook,
      flush: () => assert.ok(locked),
    },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(locked, false); locked = true; },
      hasLock() { return locked; },
      releaseLock() { locked = false; },
    }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: body => ({ setMimeType: () => JSON.parse(body) }),
    },
  });
  vm.runInContext(source.replace('const SPREADSHEET_ID = "";', 'const SPREADSHEET_ID = "test-spreadsheet";'), gas);
  return {
    get: () => gas.doGet(),
    post: body => gas.doPost({ postData: { contents: JSON.stringify(body) } }),
    sheets,
  };
}

async function imageFixture(page, name, variant, type = 'image/png') {
  const base64 = await page.evaluate(({ variant, type }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 590;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = variant === 1 ? '#e8f0ff' : '#e4f6f0';
    ctx.fillRect(0, 0, 960, 590);
    ctx.fillStyle = '#fff';
    ctx.fillRect(52, 50, 856, 490);
    ctx.fillStyle = variant === 1 ? '#315aa8' : '#14765f';
    ctx.fillRect(52, 50, 856, 92);
    ctx.font = 'bold 42px "Malgun Gothic", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(variant === 1 ? '현장 점검 결과' : '검증 체크리스트', 85, 111);
    ctx.font = '26px "Malgun Gothic", sans-serif';
    ['장비 상태 확인', '일정 및 작업 범위 확인', '검증 결과 기록'].forEach((label, i) => {
      const y = 218 + i * 95;
      ctx.fillStyle = variant === 1 ? '#315aa8' : '#14765f';
      ctx.fillRect(90, y - 26, 34, 34);
      ctx.fillStyle = '#fff';
      ctx.fillText('✓', 93, y + 2);
      ctx.fillStyle = '#27354b';
      ctx.fillText(label, 148, y);
      ctx.fillStyle = '#d9e0eb';
      ctx.fillRect(90, y + 28, 760, 2);
    });
    return canvas.toDataURL(type).split(',')[1];
  }, { variant, type });
  return { name, mimeType: type, buffer: Buffer.from(base64, 'base64') };
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.DASHBOARD_BROWSER || 'msedge', headless: true });
  const checks = [];
  const failures = [];
  const dialogs = [];
  let remote = structuredClone(legacy);
  let gas;
  let failPost = false;
  let abortRequests = false;
  const posts = [];
  const contextOptions = { viewport: { width: 1500, height: 1050 }, timezoneId: 'Asia/Seoul', acceptDownloads: true };

  async function newPage() {
    const context = await browser.newContext(contextOptions);
    await context.route('https://**/*', async route => {
      const request = route.request();
      assert.equal(new URL(request.url()).hostname, 'script.google.com');
      if (abortRequests) return route.abort();
      let response;
      if (request.method() === 'POST') {
        const payload = request.postDataJSON();
        posts.push(payload);
        if (failPost) response = { status: 'error', message: '테스트용 저장 실패' };
        else if (gas) response = gas.post(payload);
        else {
          remote = payload;
          response = { status: 'success' };
        }
      } else response = gas ? gas.get() : { status: 'success', data: remote };
      await route.fulfill({ json: response, headers: { 'access-control-allow-origin': '*' } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => failures.push(error.message));
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    await page.clock.setFixedTime(fixedDate);
    await page.goto(html);
    await idle(page);
    if (await page.evaluate(() => !gdConfig.gasUrl)) {
      assert.match(await page.locator('#cloudStatusText').innerText(), /미연동/);
      await page.getByRole('button', { name: '구글 드라이브 설정', exact: true }).click();
      await page.locator('#gasUrlInput').fill('https://script.google.com/macros/s/dashboard-test/exec');
      await page.getByRole('button', { name: '연결 테스트 & 동기화', exact: true }).click();
      await page.locator('#driveModal').waitFor({ state: 'hidden' });
      await idle(page);
    }
    return page;
  }

  const idle = page => page.waitForFunction(() => !isLoading && !isSyncing);
  const thumbs = page => page.locator('#attachmentList li');
  const row = (page, name) => page.locator('#summaryBody tr').filter({ hasText: name });
  const bar = (page, id) => page.locator('.bar[data-edit-id="' + id + '"]');
  const edit = (page, id) => page.locator('button[data-edit-id="' + id + '"]').click();
  const background = locator => locator.evaluate(el => getComputedStyle(el).backgroundColor);
  const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem(KEY)));
  const attach = async (page, files) => {
    await page.locator('#imageFiles').setInputFiles(files);
    await page.waitForFunction(() => !attachmentDraft?.processing);
  };
  const save = async page => {
    await page.locator('#submitBtn').click();
    await idle(page);
  };
  const backupInput = (page, object) => page.locator('#importFile').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(object)),
  });

  try {
    const page = await newPage();
    assert.equal(await page.locator('#summaryBody tr').count(), 7);
    assert.deepEqual(await page.locator('.summary th').allTextContents(), ['프로젝트', '내용', '담당자', '시작일', '완료일', 'Status']);
    for (const id of ['pilot', 'checklist', 'qa']) {
      assert.equal(await background(bar(page, id)), 'rgb(98, 98, 98)');
      assert.equal(await background(page.locator('.sticky').filter({ has: page.locator('button[data-edit-id="' + id + '"]') })), 'rgb(240, 240, 240)');
    }
    assert.equal(await background(row(page, 'QA 체크리스트 작성')), 'rgb(240, 240, 240)');
    assert.equal(await background(bar(page, 'review')), 'rgb(71, 119, 237)');
    assert.equal(await background(bar(page, 'flow')), 'rgb(24, 165, 140)');
    assert.equal(await background(bar(page, 'handoff')), 'rgb(164, 107, 213)');
    assert.equal(await background(page.locator('.barcell.today.is-complete').first()), 'rgb(255, 247, 237)');
    checks.push('완료 프로젝트·하위 업무 회색, 미완료 색상과 오늘 표시 유지');

    await page.locator('#search').fill('QA 체크리스트');
    assert.equal(await page.locator('#summaryBody tr').count(), 2);
    assert.equal(await page.locator('#gantt .rowlabel').count(), 2);
    await page.locator('#search').fill('없는 항목');
    assert.match(await page.locator('#summaryBody').innerText(), /표시할/);
    await page.locator('#search').fill('');
    const initialPeriod = await page.locator('#period').innerText();
    await page.getByRole('button', { name: '다음 ▶', exact: true }).click();
    assert.notEqual(await page.locator('#period').innerText(), initialPeriod);
    await page.getByRole('button', { name: '오늘', exact: true }).click();
    assert.equal(await page.locator('#period').innerText(), initialPeriod);
    await page.locator('#range').selectOption('30');
    assert.equal(await page.locator('.dayhead').count(), 30);
    checks.push('검색, 빈 결과, 날짜 이동, 기간 설정 및 진행 요약');

    const first = await imageFixture(page, '현장 점검 결과.png', 1);
    const second = await imageFixture(page, '검증 체크리스트.jpg', 2, 'image/jpeg');
    const third = await imageFixture(page, '운영 기록.webp', 1, 'image/webp');
    await page.locator('#addProjectBtn').click();
    await page.locator('#submitBtn').click();
    assert.ok(await page.locator('#modal').evaluate(el => el.classList.contains('show')));
    await page.locator('#name').fill('이미지 등록 프로젝트');
    await page.locator('#owner').fill('검증 담당자');
    await page.locator('#calgrid [data-day="2026-11-19"]').click();
    await page.locator('#calgrid [data-day="2026-11-23"]').click();
    assert.equal(await page.locator('#start').inputValue(), '2026-11-19');
    assert.equal(await page.locator('#end').inputValue(), '2026-11-23');
    await attach(page, [{ name: '잘못된 파일.png', mimeType: 'image/png', buffer: Buffer.from('불량 이미지') }]);
    assert.match(await page.locator('#attachmentMessage').innerText(), /JPG, PNG 또는 WebP/);
    await attach(page, [{ ...first, buffer: Buffer.concat([first.buffer, Buffer.alloc(10 * 1024 * 1024)]) }]);
    assert.match(await page.locator('#attachmentMessage').innerText(), /10MB/);
    await attach(page, [first, second, third, first]);
    assert.equal(await thumbs(page).count(), 3);
    assert.match(await page.locator('#attachmentMessage').innerText(), /최대 3장/);
    assert.ok(await thumbs(page).locator('img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0 && img.naturalWidth <= 720 && img.src.length <= 36000)));
    await page.locator('#attachmentList [data-preview="0"]').click();
    assert.ok(await page.locator('#attachmentPreview').isVisible());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#attachmentPreview').isVisible(), false);
    assert.ok(await page.locator('#modal').evaluate(el => el.classList.contains('show')));
    await page.locator('#attachmentList [data-remove="1"]').click();
    assert.equal(await thumbs(page).count(), 2);
    await save(page);
    const newId = remote.projects.at(-1).id;
    assert.equal(remote.projects.at(-1).images, undefined);
    assert.equal((await stored(page)).projects.at(-1).images.length, 2);
    assert.match(await page.locator('#cloudStatusText').innerText(), /첨부는 브라우저/);
    checks.push('프로젝트 등록, 3개 이미지 형식, 미리보기, 개별 삭제 및 파일·개수 제한');

    await bar(page, newId).click();
    assert.equal(await thumbs(page).count(), 2);
    await page.locator('#attachmentList [data-remove="0"]').click();
    await page.keyboard.press('Escape');
    await edit(page, newId);
    assert.equal(await thumbs(page).count(), 2);
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await page.locator('#addTaskBtn').click();
    await page.locator('#parent').selectOption('pilot');
    await page.locator('#name').fill('첨부 하위 업무');
    await page.locator('#owner').fill('김민서');
    await page.locator('#status').selectOption('완료');
    await attach(page, [second]);
    await save(page);
    const taskId = remote.tasks.at(-1).id;
    await edit(page, taskId);
    assert.equal(await thumbs(page).count(), 1);
    await attach(page, [first]);
    await page.locator('#attachmentList [data-remove="0"]').click();
    await page.locator('#status').selectOption('진행');
    await save(page);
    assert.equal(await background(bar(page, taskId)), 'rgb(71, 119, 237)');
    await page.reload();
    await idle(page);
    assert.equal((await stored(page)).projects.at(-1).images.length, 2);
    await edit(page, taskId);
    assert.equal(await thumbs(page).count(), 1);
    assert.match(await thumbs(page).innerText(), /현장 점검 결과/);
    await page.keyboard.press('Escape');
    checks.push('하위 업무 등록·수정, ESC 취소, 완료 해제, 구버전 시트와 새로고침 후 이미지 보존');

    const source = await page.evaluate(() => GAS_TEMPLATE_CODE);
    gas = mockAppsScript(source, remote);
    assert.equal(gas.get().data.projects.at(-1).images.length, 0);
    await page.locator('#syncNowBtn').click();
    await idle(page);
    assert.equal(gas.get().data.projects.at(-1).images.length, 2);
    assert.equal(gas.get().data.tasks.at(-1).images.length, 1);
    assert.equal((await stored(page)).projects.at(-1).imagesPending, undefined);
    const otherPage = await newPage();
    await edit(otherPage, taskId);
    assert.equal(await thumbs(otherPage).count(), 1);
    await otherPage.context().close();
    const originalPhoto = gas.get().data.projects.at(-1).images[0];
    const incompatible = structuredClone(gas.get().data);
    incompatible.projects.at(-1).images = [{ name: 'bad.svg', dataUrl: 'data:image/svg+xml;base64,YQ==' }];
    assert.equal(gas.post(incompatible).status, 'error');
    assert.deepEqual(gas.get().data.projects.at(-1).images[0], originalPhoto);
    const oldWriter = structuredClone(remote);
    oldWriter.projects[0].name = '시트에서 갱신된 프로젝트';
    assert.equal(gas.post(oldWriter).status, 'success');
    assert.equal(gas.get().data.projects.at(-1).images.length, 2);
    await page.evaluate(() => periodicSync());
    assert.match(await page.locator('#summaryBody').innerText(), /시트에서 갱신된 프로젝트/);
    checks.push('포함된 Apps Script로 이전 시트 읽기, 이미지 이전·다른 브라우저 조회, 구버전 쓰기 호환 및 주기 동기화');

    await edit(page, taskId);
    await page.locator('#attachmentList [data-remove="0"]').click();
    failPost = true;
    await save(page);
    assert.equal(gas.get().data.tasks.at(-1).images.length, 1);
    assert.equal((await stored(page)).pendingCloudSave, true);
    failPost = false;
    await page.locator('#syncNowBtn').click();
    await idle(page);
    assert.equal(gas.get().data.tasks.at(-1).images.length, 0);
    assert.deepEqual(posts.at(-1).tasks.at(-1).images, []);
    await edit(page, taskId);
    await page.locator('#deleteBtn').click();
    await idle(page);
    assert.equal(gas.get().data.tasks.some(item => item.id === taskId), false);
    checks.push('이미지 마지막 장 삭제, 시트 저장 실패 복구 및 하위 업무 삭제');

    await edit(page, newId);
    await page.locator('#name').fill('저장 용량 오류 테스트');
    await page.evaluate(() => {
      window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === KEY) throw new DOMException('Test quota', 'QuotaExceededError');
        return window.originalSetItem.call(this, key, value);
      };
    });
    const postCount = posts.length;
    await save(page);
    assert.match(dialogs.at(-1), /브라우저에 저장할 수 없습니다/);
    assert.equal(posts.length, postCount);
    assert.equal((await stored(page)).projects.at(-1).name, '이미지 등록 프로젝트');
    assert.equal(await page.locator('#name').inputValue(), '저장 용량 오류 테스트');
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
    await page.keyboard.press('Escape');
    const oversized = {
      projects: Array.from({ length: 20 }, (_, i) => ({
        ...legacy.projects[0],
        id: 'limit-' + i,
        images: Array.from({ length: 3 }, () => ({ name: 'limit.webp', dataUrl: 'data:image/webp;base64,' + 'AAAA'.repeat(8990) })),
      })),
      tasks: [],
    };
    await backupInput(page, oversized);
    await page.waitForFunction(() => !document.getElementById('importFile').value);
    assert.match(dialogs.at(-1), /전체 첨부 이미지 용량/);
    assert.equal(gas.post(oversized).status, 'error');
    assert.equal(posts.length, postCount);
    checks.push('전체 첨부 용량 및 브라우저 저장 실패 시 기존 데이터·폼 유지');

    const backupPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON 백업', exact: true }).click();
    const exported = JSON.parse(readFileSync(await (await backupPromise).path(), 'utf8'));
    assert.equal(exported.version, '1.3.2');
    assert.equal(exported.projects.at(-1).images.length, 2);
    assert.equal(exported.projects.at(-1).imagesPending, undefined);
    await backupInput(page, legacy);
    await page.waitForFunction(() => data.projects.length === 3 && !isSyncing);
    assert.equal(await page.locator('#summaryBody tr').count(), 7);
    await backupInput(page, exported);
    await page.waitForFunction(() => data.projects.length === 4 && !isSyncing);
    assert.equal(gas.get().data.projects.at(-1).images.length, 2);
    const pdfPromise = page.waitForEvent('download');
    await page.locator('#downloadPdfBtn').click();
    assert.equal(readFileSync(await (await pdfPromise).path()).subarray(0, 4).toString(), '%PDF');
    checks.push('이미지 포함 JSON 백업/복원, v1.3.1 백업 복원 및 PDF 다운로드');

    await edit(page, 'release');
    await page.locator('#deleteBtn').click();
    await idle(page);
    assert.ok(gas.get().data.projects.every(item => item.id !== 'release'));
    assert.ok(gas.get().data.tasks.every(item => item.projectId !== 'release'));
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw Error('클립보드 테스트'); } },
      });
    });
    await page.getByRole('button', { name: '구글 드라이브 설정', exact: true }).click();
    await page.getByRole('button', { name: /배포용 스크립트 코드 복사/ }).click();
    await page.locator('#gasCodeText').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#gasCodeText').inputValue(), source);
    await page.keyboard.press('Escape');
    checks.push('프로젝트 삭제 시 하위 업무 함께 삭제 및 배포 코드 수동 복사');

    await backupInput(page, legacy);
    await page.waitForFunction(() => data.projects.length === 3 && !isSyncing);
    await page.locator('#toast').evaluate(el => { el.hidden = true; });
    await page.screenshot({ path: path.join(__dirname, '대시보드_v1.3.2_미리보기.png'), fullPage: true });
    await page.setViewportSize({ width: 1500, height: 1270 });
    await edit(page, 'pilot');
    await attach(page, [first, second]);
    await page.locator('#modal .dialog').screenshot({ path: path.join(__dirname, '이미지첨부_v1.3.2_미리보기.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('.summary-scroll').evaluate(el => el.scrollWidth > el.clientWidth));
    await edit(page, 'pilot');
    await attach(page, [first, second]);
    assert.ok(await page.locator('#imageFiles').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    assert.ok(await page.locator('#attachmentList').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.keyboard.press('Escape');
    checks.push('모바일 폼 첨부 및 진행 요약 가로 스크롤');

    abortRequests = true;
    await page.reload();
    await idle(page);
    assert.equal(await page.locator('#summaryBody tr').count(), 7);
    const postCountOffline = posts.length;
    await page.evaluate(() => {
      window.offlineFileWrites = [];
      window.showSaveFilePicker = async () => ({
        name: 'dashboard.json',
        createWritable: async () => ({
          write: async value => window.offlineFileWrites.push(JSON.parse(value)),
          close: async () => {},
        }),
      });
    });
    await page.getByRole('button', { name: '구글 드라이브 설정', exact: true }).click();
    await page.locator('#tabFileBtn').click();
    await page.getByRole('button', { name: /구글 드라이브 폴더의 파일 선택/ }).click();
    await page.locator('#driveModal').waitFor({ state: 'hidden' });
    await edit(page, 'pilot');
    await attach(page, [first]);
    await save(page);
    await page.waitForFunction(() => window.offlineFileWrites.length === 2);
    assert.equal(await page.evaluate(() => window.offlineFileWrites.at(-1).projects[0].images.length), 1);
    assert.equal(posts.length, postCountOffline);
    await page.reload();
    await idle(page);
    assert.equal((await stored(page)).projects[0].images.length, 1);
    assert.match(await page.locator('#cloudStatusText').innerText(), /로컬 드라이브 파일 연결 필요/);
    checks.push('오프라인 브라우저 저장 및 연결된 JSON 파일에 첨부 이미지 기록');
    assert.deepEqual(failures, []);
    checks.push('오프라인 재열기 및 브라우저 JavaScript 오류 없음');
    console.log(checks.map(check => 'PASS ' + check).join('\n'));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
