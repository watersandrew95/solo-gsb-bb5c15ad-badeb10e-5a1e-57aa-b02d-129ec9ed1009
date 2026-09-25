'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');
const { validateBackup } = require('../server/familyGraph');
const {
  parseMonthDay,
  parseLocalDate,
  nextOccurrence,
  buildUpcoming,
} = require('../server/memorials');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-memorial-'));
  return path.join(dir, 'family.json');
}

/* ---------------- parseMonthDay：月日校验与归一化 ---------------- */

test('月日解析：合法输入归一化为 MM-DD（兼容省略前导零与常见分隔符）', () => {
  assert.deepEqual(parseMonthDay('02-29'), { value: '02-29', month: 2, day: 29 });
  assert.deepEqual(parseMonthDay('2-29'), { value: '02-29', month: 2, day: 29 });
  assert.deepEqual(parseMonthDay('12-31'), { value: '12-31', month: 12, day: 31 });
  assert.deepEqual(parseMonthDay('1/5'), { value: '01-05', month: 1, day: 5 });
  assert.deepEqual(parseMonthDay(' 8.7 '), { value: '08-07', month: 8, day: 7 });
});

test('月日解析：非法日期一律拒绝（2-30、4-31、13-01、0 月、0 日、非字符串、格式错误）', () => {
  for (const bad of ['02-30', '2-30', '04-31', '13-01', '00-10', '1-0', '2-29-1', 'abc', '2024-02-29', '']) {
    assert.ok(parseMonthDay(bad).error, `应拒绝：${JSON.stringify(bad)}`);
  }
  assert.ok(parseMonthDay(null).error);
  assert.ok(parseMonthDay(undefined).error);
  assert.ok(parseMonthDay(229).error);
});

test('月日解析：2 月 29 日是合法月日（不依赖具体年份）', () => {
  assert.equal(parseMonthDay('02-29').error, undefined);
  assert.equal(parseMonthDay('2-29').value, '02-29');
});

/* ---------------- nextOccurrence：逐年求下一次日期 ---------------- */

test('下一次日期：今天即纪念日时返回今天（距今天数 0）', () => {
  const base = { year: 2026, month: 9, day: 25 };
  assert.deepEqual(nextOccurrence(9, 25, base), { year: 2026, month: 9, day: 25 });
});

test('下一次日期：本年未过取本年，已过取次年（跨年准确）', () => {
  assert.deepEqual(nextOccurrence(12, 31, { year: 2026, month: 9, day: 25 }), { year: 2026, month: 12, day: 31 });
  assert.deepEqual(nextOccurrence(1, 5, { year: 2026, month: 12, day: 20 }), { year: 2027, month: 1, day: 5 });
  assert.deepEqual(nextOccurrence(9, 24, { year: 2026, month: 9, day: 25 }), { year: 2027, month: 9, day: 24 });
});

test('下一次日期：2 月 29 日在平年落到 2 月 28 日，闰年仍为 2 月 29 日', () => {
  // 2025、2026、2027 均为平年
  assert.deepEqual(nextOccurrence(2, 29, { year: 2025, month: 3, day: 1 }), { year: 2026, month: 2, day: 28 });
  assert.deepEqual(nextOccurrence(2, 29, { year: 2026, month: 3, day: 1 }), { year: 2027, month: 2, day: 28 });
  // 2028 为闰年
  assert.deepEqual(nextOccurrence(2, 29, { year: 2027, month: 3, day: 1 }), { year: 2028, month: 2, day: 29 });
  // 闰年当天与之前
  assert.deepEqual(nextOccurrence(2, 29, { year: 2028, month: 2, day: 29 }), { year: 2028, month: 2, day: 29 });
  assert.deepEqual(nextOccurrence(2, 29, { year: 2028, month: 2, day: 1 }), { year: 2028, month: 2, day: 29 });
  // 闰年 2 月 29 日刚过：下一个平年落 2 月 28 日
  assert.deepEqual(nextOccurrence(2, 29, { year: 2028, month: 3, day: 1 }), { year: 2029, month: 2, day: 28 });
});

/* ---------------- buildUpcoming：未来 30 天清单 ---------------- */

test('未来 30 天：窗口含今天（0–29 天），第 30 天排除', () => {
  const members = [
    { id: 'a', name: '甲', birthday: '09-25', deathday: null }, // 今天
    { id: 'b', name: '乙', birthday: '10-24', deathday: null }, // 第 29 天
    { id: 'c', name: '丙', birthday: '10-25', deathday: null }, // 第 30 天，排除
    { id: 'd', name: '丁', birthday: null, deathday: null }, // 未登记
  ];
  const r = buildUpcoming(members, '2026-09-25');
  assert.equal(r.error, undefined);
  assert.equal(r.today, '2026-09-25');
  assert.equal(r.windowDays, 30);
  assert.deepEqual(
    r.items.map((i) => [i.name, i.daysFromToday]),
    [['甲', 0], ['乙', 29]],
  );
  assert.equal(r.items[0].date, '2026-09-25');
  assert.equal(r.items[1].date, '2026-10-24');
});

test('未来 30 天：跨年窗口准确（12 月看次年 1 月）', () => {
  const members = [
    { id: 'a', name: '甲', birthday: '01-05', deathday: null },
    { id: 'b', name: '乙', birthday: null, deathday: '12-31' },
  ];
  const r = buildUpcoming(members, '2026-12-20');
  assert.deepEqual(
    r.items.map((i) => [i.name, i.type, i.date, i.daysFromToday]),
    [
      ['乙', 'deathday', '2026-12-31', 11],
      ['甲', 'birthday', '2027-01-05', 16],
    ],
  );
});

test('未来 30 天：2 月 29 日平年落到 2 月 28 日并进入清单', () => {
  const members = [{ id: 'a', name: '甲', birthday: '02-29', deathday: null }];
  const plain = buildUpcoming(members, '2025-02-01');
  assert.deepEqual(
    plain.items.map((i) => [i.date, i.daysFromToday]),
    [['2025-02-28', 27]],
  );
  const leap = buildUpcoming(members, '2028-02-01');
  assert.deepEqual(
    leap.items.map((i) => [i.date, i.daysFromToday]),
    [['2028-02-29', 28]],
  );
});

test('未来 30 天：同日按姓名、类型（生日先于忌日）稳定排序', () => {
  const members = [
    { id: 'm1', name: '张三', birthday: null, deathday: '10-01' },
    { id: 'm2', name: '李四', birthday: '10-01', deathday: null },
    { id: 'm3', name: '张三', birthday: '10-01', deathday: null },
    { id: 'm4', name: '王五', birthday: '10-01', deathday: '10-01' },
  ];
  const r = buildUpcoming(members, '2026-09-25');
  // 5 条全部落在同一天
  assert.equal(r.items.length, 5);
  assert.ok(r.items.every((i) => i.daysFromToday === 6));

  // 逐对验证排序规则：姓名（zh 排序）→ 类型（生日先于忌日）→ 成员 ID
  for (let i = 1; i < r.items.length; i++) {
    const prev = r.items[i - 1];
    const cur = r.items[i];
    const nameCmp = prev.name.localeCompare(cur.name, 'zh');
    if (nameCmp !== 0) {
      assert.ok(nameCmp < 0, `姓名顺序错误：${prev.name} 应排在 ${cur.name} 前`);
    } else if (prev.type !== cur.type) {
      assert.equal(prev.type, 'birthday', '同名时生日应排在忌日前');
    } else {
      assert.ok(prev.memberId < cur.memberId, '同姓名同类型时按成员 ID 稳定排序');
    }
  }
  // 同名「张三」：生日在忌日前
  const zhangsan = r.items.filter((i) => i.name === '张三');
  assert.deepEqual(zhangsan.map((i) => i.type), ['birthday', 'deathday']);
  // 同一人「王五」两项：生日在忌日前
  const wangwu = r.items.filter((i) => i.name === '王五');
  assert.deepEqual(wangwu.map((i) => i.type), ['birthday', 'deathday']);
});

test('未来 30 天：非法本地日期被拒绝', () => {
  assert.ok(buildUpcoming([], '2026-13-01').error);
  assert.ok(buildUpcoming([], '2026-02-30').error);
  assert.ok(buildUpcoming([], 'not-a-date').error);
  assert.ok(buildUpcoming([], '').error);
  // 2024 是闰年，2-29 合法；2025 不是
  assert.equal(buildUpcoming([], '2024-02-29').error, undefined);
  assert.ok(buildUpcoming([], '2025-02-29').error);
});

test('本地日期解析：严格 YYYY-MM-DD，校验真实存在的日期', () => {
  assert.deepEqual(parseLocalDate('2026-09-25'), { year: 2026, month: 9, day: 25 });
  assert.ok(parseLocalDate('2026-9-25').error);
  assert.ok(parseLocalDate('20260925').error);
  assert.ok(parseLocalDate('2026-04-31').error);
});

/* ---------------- store：登记 / 修改 / 删除纪念日 ---------------- */

test('登记生日与忌日后随成员持久化（重启后仍在）', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('甲').member;

  const r = store.setMemorials(a.id, '02-29', '8-7');
  assert.equal(r.error, null);
  assert.equal(r.member.birthday, '02-29');
  assert.equal(r.member.deathday, '08-07');

  // 落盘内容包含纪念日
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.members[0].birthday, '02-29');
  assert.equal(raw.members[0].deathday, '08-07');

  // 重启后恢复
  const reloaded = createStore(file).list();
  assert.equal(reloaded.members[0].birthday, '02-29');
  assert.equal(reloaded.members[0].deathday, '08-07');
});

test('修改与删除纪念日：置 null 即删除对应日期', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  assert.equal(store.setMemorials(a.id, '01-01', '12-31').error, null);

  // 修改生日
  assert.equal(store.setMemorials(a.id, '02-02', '12-31').error, null);
  let m = store.list().members[0];
  assert.equal(m.birthday, '02-02');
  assert.equal(m.deathday, '12-31');

  // 删除忌日（生日保留）
  assert.equal(store.setMemorials(a.id, '02-02', null).error, null);
  m = store.list().members[0];
  assert.equal(m.birthday, '02-02');
  assert.equal(m.deathday, null);

  // 全部清空
  assert.equal(store.setMemorials(a.id, null, null).error, null);
  m = store.list().members[0];
  assert.equal(m.birthday, null);
  assert.equal(m.deathday, null);
});

test('非法日期被拒绝且不改变数据（版本不变、原值保留）', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  assert.equal(store.setMemorials(a.id, '03-03', null).error, null);
  const v = store.getVersion();

  for (const bad of ['02-30', '13-01', '04-31', 'abc', '2024-01-01']) {
    const r = store.setMemorials(a.id, bad, null);
    assert.ok(r.error, `应拒绝：${bad}`);
  }
  // 忌日非法同样拒绝
  assert.ok(store.setMemorials(a.id, null, '2-30').error);

  assert.equal(store.getVersion(), v);
  const m = store.list().members[0];
  assert.equal(m.birthday, '03-03');
  assert.equal(m.deathday, null);
});

test('纪念日接口：字段缺失 / 成员不存在 / 无变化均被拒绝且不写入', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  const v = store.getVersion();

  // 字段缺失（undefined）
  assert.ok(store.setMemorials(a.id, undefined, null).error);
  assert.ok(store.setMemorials(a.id, '01-01', undefined).error);
  // 成员不存在
  const missing = store.setMemorials('no-such-id', '01-01', null);
  assert.equal(missing.status, 404);
  // 与现值完全一致（无变化）
  assert.equal(store.setMemorials(a.id, null, null).error !== null, true);

  assert.equal(store.getVersion(), v);
  assert.equal(store.list().members[0].birthday, null);
});

test('删除成员时其纪念日一并移除（清单不再出现）', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  const b = store.addMember('乙').member;
  store.setMemorials(a.id, '09-26', null);
  store.setMemorials(b.id, null, '09-26');

  assert.equal(store.deleteMember(a.id).error, null);
  const data = store.list();
  assert.equal(data.members.length, 1);
  assert.equal(data.members[0].birthday, null);
  assert.equal(data.members[0].deathday, '09-26');

  const up = store.upcomingMemorials('2026-09-25');
  assert.deepEqual(up.items.map((i) => i.name), ['乙']);
});

test('撤销恢复纪念日：登记后撤销回到未登记，删除成员撤销后纪念日还原', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;

  // 登记后撤销
  assert.equal(store.setMemorials(a.id, '05-06', '07-08').error, null);
  assert.equal(store.list().members[0].birthday, '05-06');
  assert.equal(store.undoLast(store.getVersion()).error, null);
  assert.equal(store.list().members[0].birthday, null);
  assert.equal(store.list().members[0].deathday, null);

  // 删除成员后撤销：成员与其纪念日一起回来
  assert.equal(store.setMemorials(a.id, '05-06', null).error, null);
  assert.equal(store.deleteMember(a.id).error, null);
  assert.equal(store.list().members.length, 0);
  assert.equal(store.undoLast(store.getVersion()).error, null);
  const restored = store.list().members[0];
  assert.equal(restored.id, a.id);
  assert.equal(restored.birthday, '05-06');
});

test('撤销快照落盘包含纪念日：重启后仍可撤销纪念日变更', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('甲').member;
  store.setMemorials(a.id, '11-11', null);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.undo.family.members[0].birthday, null); // 变更前快照：未登记
  assert.equal(raw.members[0].birthday, '11-11');

  // 重启后撤销仍然有效
  const store2 = createStore(file);
  assert.equal(store2.undoLast(store2.getVersion()).error, null);
  assert.equal(store2.list().members[0].birthday, null);
});

test('旧数据文件缺少纪念日字段时视为空（加载不报错）', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    maxMembers: 30,
    members: [{ id: 'a', name: '甲' }],
    edges: [],
    undo: null,
  }));
  const store = createStore(file);
  const m = store.list().members[0];
  assert.equal(m.birthday, null);
  assert.equal(m.deathday, null);
});

/* ---------------- 备份与恢复 ---------------- */

test('备份恢复：纪念日随备份迁移（往返一致）', () => {
  const source = createStore(tmpFile());
  const a = source.addMember('甲').member;
  const b = source.addMember('乙').member;
  source.setMemorials(a.id, '02-29', null);
  source.setMemorials(b.id, null, '08-07');
  const content = JSON.stringify({
    members: source.list().members.map((m) => ({
      id: m.id, name: m.name, birthday: m.birthday, deathday: m.deathday,
    })),
    edges: [],
  });

  const target = createStore(tmpFile());
  const preview = target.previewRestore(content);
  assert.equal(preview.valid, true);
  const r = target.restoreBackup(content, preview.fingerprint, target.getVersion());
  assert.equal(r.error, null);

  const byId = Object.fromEntries(target.list().members.map((m) => [m.id, m]));
  assert.equal(byId[a.id].birthday, '02-29');
  assert.equal(byId[a.id].deathday, null);
  assert.equal(byId[b.id].birthday, null);
  assert.equal(byId[b.id].deathday, '08-07');
});

test('旧备份缺少纪念日字段：恢复后视为空', () => {
  const store = createStore(tmpFile());
  const content = JSON.stringify({
    members: [{ id: 'a', name: '甲' }],
    edges: [],
  });
  const preview = store.previewRestore(content);
  assert.equal(preview.valid, true);
  assert.equal(store.restoreBackup(content, preview.fingerprint, store.getVersion()).error, null);
  assert.equal(store.list().members[0].birthday, null);
  assert.equal(store.list().members[0].deathday, null);
});

test('备份校验：纪念日字段非法时逐项报错且整份不可恢复', () => {
  const r = validateBackup({
    members: [
      { id: 'a', name: '甲', birthday: '02-30' },
      { id: 'b', name: '乙', deathday: '13-01' },
      { id: 'c', name: '丙', birthday: 'not-a-date' },
      { id: 'd', name: '丁', birthday: '02-29', deathday: '08-07' },
    ],
    edges: [],
  });
  assert.equal(r.valid, false);
  const memorialErrors = r.errors.filter((e) => e.where === 'member');
  assert.equal(memorialErrors.length, 3);
  assert.ok(memorialErrors.some((e) => e.index === 0 && /生日/.test(e.message)));
  assert.ok(memorialErrors.some((e) => e.index === 1 && /忌日/.test(e.message)));
  assert.ok(memorialErrors.some((e) => e.index === 2));
  // 合法成员（含 2-29）正常进入净化列表
  assert.deepEqual(
    r.members.map((m) => [m.id, m.birthday, m.deathday]),
    [['d', '02-29', '08-07']],
  );
});

test('备份校验：旧格式备份（无纪念日字段）合法且归一化为空', () => {
  const r = validateBackup({
    members: [{ id: 'a', name: '甲' }],
    edges: [],
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.members, [{ id: 'a', name: '甲', birthday: null, deathday: null }]);
});

/* ---------------- store.upcomingMemorials ---------------- */

test('store 未来 30 天清单：按提交的本地日期计算，非法日期返回 400', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  store.setMemorials(a.id, '09-25', '09-30');

  const r = store.upcomingMemorials('2026-09-25');
  assert.equal(r.error, null);
  assert.deepEqual(
    r.items.map((i) => [i.type, i.daysFromToday]),
    [['birthday', 0], ['deathday', 5]],
  );

  const bad = store.upcomingMemorials('2026-02-30');
  assert.equal(bad.status, 400);
  assert.ok(bad.error);
});
