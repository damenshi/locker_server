const axios = require('axios');

async function queryTodayOrders() {
    // CloudBase 环境 ID
    const envId = 'cloudbase-3gnr17whd71a5b45';
    
    // 今天时间范围
    const todayStart = new Date('2026-03-17T00:00:00+08:00');
    const todayEnd = new Date('2026-03-17T23:59:59+08:00');
    
    console.log('═══════════════════════════════════════════════');
    console.log('  2026年3月17日 收费订单统计');
    console.log('═══════════════════════════════════════════════\n');
    
    console.log('⚠️  需要通过 CloudBase HTTP API 查询');
    console.log('    需要配置 SecretId 和 SecretKey 才能访问\n');
    
    console.log('设备地址映射:');
    console.log('───────────────────────────────────────────────');
    const devices = {
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
    
    for (const [id, addr] of Object.entries(devices)) {
        console.log(id + '  →  ' + addr);
    }
    
    console.log('\n若要获取今天的订单数据，可以通过:');
    console.log('1. 小程序后台查看');
    console.log('2. 配置 CloudBase 访问密钥后查询');
    console.log('3. 直接查询数据库\n');
}

queryTodayOrders();
