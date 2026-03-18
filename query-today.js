const { MongoClient } = require('mongodb');

async function queryToday() {
    // 今天时间范围 (2026-03-17)
    const start = new Date('2026-03-17T00:00:00+08:00');
    const end = new Date('2026-03-17T23:59:59+08:00');
    
    console.log('查询时间范围:');
    console.log('开始:', start.toISOString());
    console.log('结束:', end.toISOString());
    console.log('');
    
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
    
    console.log('设备地址表:');
    for (const [id, addr] of Object.entries(deviceAddresses)) {
        console.log('  ' + id + ' = ' + addr);
    }
}

queryToday().catch(console.error);
