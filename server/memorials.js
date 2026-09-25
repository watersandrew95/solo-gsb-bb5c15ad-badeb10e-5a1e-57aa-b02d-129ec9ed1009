'use strict';

/**
 * 纪念日（生日 / 忌日）核心逻辑（纯函数，不依赖 Node API，便于测试）。
 *
 * 每名成员至多登记一个生日与一个忌日，均为**公历月日**（不含年份），
 * 内部统一用 "MM-DD" 字符串表示（如 "02-29"），年份无关、可逐年求下一次日期。
 *
 * 本模块只处理公历的「月 + 日」，不使用任何带时区的 Date 构造：
 * 日期比较与「距今天数」均以本地日历日为单位（UTC 整日相减），
 * 因此结果与运行进程的时区无关——浏览器把用户本地日期以 "YYYY-MM-DD"
 * 原样提交，服务端按同一本地日历语义计算。
 */

const MEMORIAL_TYPES = ['birthday', 'deathday'];
const TYPE_LABELS = { birthday: '生日', deathday: '忌日' };

/** 公历某月的天数（year 为完整四位年份，2 月由闰年判定给出 28/29） */
function daysInMonth(year, month) {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  // 4、6、9、11 月 30 天，其余 31 天
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 解析并校验月日输入，归一化为 "MM-DD"。
 * 兼容浏览器表单的常见写法："02-29" / "2-29" / "02/3"（分隔符允许 - / . / 空格）。
 * 成功返回 { value: "MM-DD", month: 2, day: 29 }；非法（非字符串、格式错误、
 * 月越界、日越界，如 "02-30"、"13-01"）返回 { error }。
 * 注意：2 月 29 日是**合法月日**（不依赖具体年份），平年落到 28 日由求下一次日期处理。
 */
function parseMonthDay(raw) {
  if (typeof raw !== 'string') {
    return { error: '日期必须是 "MM-DD" 形式的字符串，如 02-29' };
  }
  // 允许的分隔符：- / . 与空格（连字符放在字符类末尾，避免被当成 ASCII 区间）
  const match = /^\s*(\d{1,2})\s*[/ .-]\s*(\d{1,2})\s*$/.exec(raw);
  if (!match) {
    return { error: '日期格式不正确，请按「月-日」填写，如 02-29 或 2-29' };
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12) {
    return { error: `月份 ${month} 无效：公历月份必须在 1–12 之间` };
  }
  // 用 2 月 29 日合法的闰年探测该月最大日数（仅月日，不绑定年份）
  const maxDay = daysInMonth(2000, month);
  if (day < 1 || day > maxDay) {
    return {
      error: `${month} 月没有 ${day} 日：该月最多 ${maxDay} 天，请重新填写`,
    };
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return { value: `${mm}-${dd}`, month, day };
}

/** 严格解析浏览器提交的本地日历日期 "YYYY-MM-DD"（拒绝 2024-2-9、20240209 等） */
function parseLocalDate(raw) {
  if (typeof raw !== 'string') return { error: '日期必须是 YYYY-MM-DD 形式的字符串' };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    return { error: '日期格式不正确，应为 YYYY-MM-DD（如 2026-09-25）' };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { error: `日期 ${raw} 不存在：请检查月与日是否合法（含闰年 2 月）` };
  }
  return { year, month, day };
}

/** 以 UTC 整日表示本地日历日（与时区无关），便于整日相减 */
function dayIndex(year, month, day) {
  return Date.UTC(year, month - 1, day) / 86400000;
}

/**
 * 求某个「月日」从 base 当日（含）起的下一次公历日期。
 * 先看本年同月同日是否不早于今天，否则取次年；2 月 29 日在平年自动落到
 * **2 月 28 日**（通过钳制到该月实际最后一天实现），在闰年仍为 2 月 29 日。
 */
function nextOccurrence(month, day, base) {
  for (const year of [base.year, base.year + 1]) {
    const actualDay = Math.min(day, daysInMonth(year, month));
    if (
      year > base.year ||
      month > base.month ||
      (month === base.month && actualDay >= base.day)
    ) {
      return { year, month, day: actualDay };
    }
  }
  // 理论不可达：两年之内必然命中
  throw new Error('无法计算下一次纪念日日期');
}

/** 把 "MM-DD" 拆成 { month, day }（parseMonthDay 已保证合法） */
function splitMonthDay(value) {
  return { month: Number(value.slice(0, 2)), day: Number(value.slice(3, 5)) };
}

/**
 * 生成从 base 当日（含）起未来 30 天（即距今天数 0–29）的纪念日清单。
 * members: [{ id, name, birthday: "MM-DD"|null, deathday: "MM-DD"|null }]
 *
 * 逐年求每名下一次日期（跨年准确，2 月 29 日平年落 2 月 28 日），
 * 仅保留落在 30 天窗口内的条目。
 * 排序：日期升序（距今天数升序）→ 同日按姓名（localeCompare('zh')）→
 * 类型（生日 birthday 在前、忌日 deathday 在后）→ 成员 ID，保证稳定可复现。
 *
 * 返回 { today: "YYYY-MM-DD", windowDays: 30, items: [{
 *   memberId, name, type, typeLabel, monthDay: "MM-DD",
 *   date: "YYYY-MM-DD", daysFromToday
 * }] }
 */
function buildUpcoming(members, baseRaw) {
  const parsed = parseLocalDate(typeof baseRaw === 'string' ? baseRaw : '');
  if (parsed.error) {
    return { error: parsed.error };
  }
  const base = parsed;
  const WINDOW_DAYS = 30;
  const baseIndex = dayIndex(base.year, base.month, base.day);
  const pad = (n) => String(n).padStart(2, '0');

  const items = [];
  for (const m of members || []) {
    if (!m || typeof m.id !== 'string') continue;
    for (const type of MEMORIAL_TYPES) {
      const value = m[type];
      if (typeof value !== 'string') continue;
      const md = splitMonthDay(value);
      const next = nextOccurrence(md.month, md.day, base);
      const daysFromToday = dayIndex(next.year, next.month, next.day) - baseIndex;
      if (daysFromToday < 0 || daysFromToday >= WINDOW_DAYS) continue;
      items.push({
        memberId: m.id,
        name: typeof m.name === 'string' ? m.name : '',
        type,
        typeLabel: TYPE_LABELS[type],
        monthDay: value,
        date: `${next.year}-${pad(next.month)}-${pad(next.day)}`,
        daysFromToday,
      });
    }
  }

  items.sort((a, b) => {
    if (a.daysFromToday !== b.daysFromToday) return a.daysFromToday - b.daysFromToday;
    const nameCmp = a.name.localeCompare(b.name, 'zh');
    if (nameCmp !== 0) return nameCmp;
    if (a.type !== b.type) return a.type === 'birthday' ? -1 : 1;
    return a.memberId.localeCompare(b.memberId);
  });

  return {
    today: `${pad(base.year)}-${pad(base.month)}-${pad(base.day)}`,
    windowDays: WINDOW_DAYS,
    items,
  };
}

module.exports = {
  MEMORIAL_TYPES,
  TYPE_LABELS,
  daysInMonth,
  isLeapYear,
  parseMonthDay,
  parseLocalDate,
  nextOccurrence,
  buildUpcoming,
};
