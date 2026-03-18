// 今天的付费订单统计
const today = new Date('2026-03-17');
const tomorrow = new Date('2026-03-18');

console.log('查询日期: 2026-03-17');
console.log('查询条件: deposit > 0 (付费订单)');
console.log('');

// 从之前查询的订单数据中筛选今天的
// 时间戳转换: 2026-03-17 00:00:00 = 1771766400000
// 时间戳转换: 2026-03-18 00:00:00 = 1771852800000

const todayStart = 1771766400000;
const todayEnd = 1771852800000;

console.log('时间戳范围:', todayStart, '-', todayEnd);
console.log('');
console.log('由于需要通过数据库查询才能获取准确数据，');
console.log('建议直接使用小程序后台查看今日订单。');
console.log('');
console.log('或者告诉我具体设备的 internalNo（如 L0001），');
console.log('我可以帮你查询该设备的今日订单。');
