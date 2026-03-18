const axios = require('axios');

async function queryPaidOrders() {
    // 调用云函数或直接查询
    // 这里通过已有的HTTP API查询
    
    console.log('查询付费订单 (deposit > 0)...');
    console.log('');
    
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
        'aeb82f6201ddc96b': 'MONSTER HOUSE(成都晶融汇店)2',
        'e6d323a62046a4ab': '车之都科目三',
        '1f02fab3f28de367': '智杰驾考科目三',
        'fa23d3e1fc60a45b': '全通驾考',
        '92b69dc11c43cdd5': '迈达盛科目三（2）',
        '89453794945d9a1e': '车之都科目四'
    };
    
    console.log('设备地址映射表（用于后续订单统计）:');
    console.log('─────────────────────────────────────────────');
    Object.entries(deviceMap).forEach(([id, addr]) => {
        console.log(id + '  →  ' + addr);
    });
    
    console.log('');
    console.log('注：需要通过数据库查询才能获取准确的付费订单统计');
    console.log('建议：使用小程序后台或 MongoDB 客户端查询');
}

queryPaidOrders();
