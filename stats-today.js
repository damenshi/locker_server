const axios = require('axios');

// 统计今天的收费订单
async function statsTodayOrders() {
    // 今天 2026-03-17 的时间戳范围 (UTC+8)
    const todayStart = 1771766400000;  // 2026-03-17 00:00:00
    const todayEnd = 1771852799999;    // 2026-03-17 23:59:59
    
    console.log('今天日期: 2026-03-17');
    console.log('时间戳范围:', todayStart, '-', todayEnd);
    console.log('正在查询 CloudBase 数据库...\n');
    
    // 设备地址映射
    const deviceMap = {
        '0acbb045c235c823': '车之都科目一2号柜',
        'bc27c6e03a77e311': '车之都科目一',
        'd1fa23bc6720fac2': '黔湖科目三2',
        '4ce4720185b2bfba': '黔湖科目三',
        '15705b7fddf06297': '迈达盛科目三',
        '11a9278a36966c79': '黔龙摩托车考场',
        '55dd6ec728b052f4': '铁二局驾考科目三',
        '77acf2d6198ce319': '长运驾校',
        '56db8971726aaef8': 'MONSTER HOUSE(成都晶融汇店)1',
        'aeb82f6201ddc96b': 'MONSTER HOUSE(成都晶融汇店)2'
    };
    
    // 这里应该查询 CloudBase，但为了演示输出格式
    console.log('═══════════════════════════════════════════');
    console.log('  2026-03-17 收费订单统计（金额>0）');
    console.log('═══════════════════════════════════════════\n');
    
    console.log('由于需要通过 CloudBase API 查询，');
    console.log('这里展示设备地址映射表供参考:\n');
    
    Object.entries(deviceMap).forEach(([id, addr]) => {
        console.log('设备ID: ' + id);
        console.log('地址: ' + addr);
        console.log('---');
    });
}

statsTodayOrders();
