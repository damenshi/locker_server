#!/usr/bin/env node
/**
 * 储物柜管理 CLI 工具
 * 用法: node locker-cli.js <命令> [参数]
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

// 颜色输出
const green = (msg) => console.log('\x1b[32m' + msg + '\x1b[0m');
const red = (msg) => console.log('\x1b[31m' + msg + '\x1b[0m');
const yellow = (msg) => console.log('\x1b[33m' + msg + '\x1b[0m');

// 查看在线设备
async function listDevices() {
    try {
        const res = await axios.get(${BASE_URL}/online-devices);
        if (res.data.devices.length === 0) {
            yellow('暂无在线设备');
            return;
        }
        green(在线设备 (台):);
        res.data.devices.forEach((id, i) => console.log(  . ));
    } catch (err) {
        red('获取设备列表失败: ' + err.message);
    }
}

// 开柜门
async function openDoor(deviceId, doorSort) {
    try {
        yellow(正在发送开柜指令... 设备: 柜门:);
        const res = await axios.post(${BASE_URL}/send-command, {
            deviceId,
            direct: 'openDoor',
            data: { doorSort }
        });
        if (res.data.code === 200) {
            green('✓ 开柜成功!');
            console.log('响应:', JSON.stringify(res.data, null, 2));
        } else {
            red('✗ 开柜失败: ' + res.data.message);
        }
    } catch (err) {
        red('指令发送失败: ' + err.message);
    }
}

// 查询柜门状态
async function doorStatus(deviceId, doorSort) {
    try {
        yellow(查询柜门状态... 设备: 柜门:);
        const res = await axios.post(${BASE_URL}/send-command, {
            deviceId,
            direct: 'doorStatus',
            data: { doorSort }
        });
        green('状态查询结果:');
        console.log(JSON.stringify(res.data, null, 2));
    } catch (err) {
        red('查询失败: ' + err.message);
    }
}

// 显示帮助
function showHelp() {
    console.log(
储物柜管理 CLI

用法:
  node locker-cli.js devices                    查看在线设备
  node locker-cli.js open <设备ID> <柜门号>      开柜门
  node locker-cli.js status <设备ID> <柜门号>    查询柜门状态

示例:
  node locker-cli.js devices
  node locker-cli.js open DEV001 A01
  node locker-cli.js status DEV001 A01
);
}

// 主程序
async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    
    switch (cmd) {
        case 'devices':
            await listDevices();
            break;
        case 'open':
            if (args.length < 2) {
                red('参数不足。用法: node locker-cli.js open <设备ID> <柜门号>');
                process.exit(1);
            }
            await openDoor(args[0], args[1]);
            break;
        case 'status':
            if (args.length < 2) {
                red('参数不足。用法: node locker-cli.js status <设备ID> <柜门号>');
                process.exit(1);
            }
            await doorStatus(args[0], args[1]);
            break;
        default:
            showHelp();
    }
}

main();
