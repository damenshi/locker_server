const axios = require('axios');

async function analyzeTodayOrders() {
    // 今天的时间戳范围 (2026-03-17 UTC+8)
    const todayStart = 1771766400000;  // 2026-03-17 00:00:00 CST
    const todayEnd = 1771852799999;    // 2026-03-17 23:59:59 CST
    
    // 设备地址映射
    const deviceAddresses = {
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
    
    const deviceStats = {};
    
    // 通过 CloudBase HTTP API 查询
    try {
        const envId = 'cloudbase-3gnr17whd71a5b45';
        const url = 'https://tcb-api.tencentcloudapi.com/web?env=' + envId;
        
        console.log('正在查询 2026-03-17 的收费订单...\n');
        console.log('设备地址映射表:');
        Object.entries(deviceAddresses).forEach(([id, addr]) => {
            console.log('  ' + id + ' = ' + addr);
        });
        console.log('\n注意: 需要通过 HTTP API 查询今天的数据');
        
    } catch (err) {
        console.error('查询失败:', err.message);
    }
}

analyzeTodayOrders();
