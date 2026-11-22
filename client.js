// Client 半片：右侧栏「手机遥控」标签页（多设备 + 扫码/配对添加 + 手动操控）。
//
// 设计要点：
// - 布局固定：状态条、截图区、按键网格都预留固定高度，操作时不会顶动其它按钮。
// - 多设备：显示设备列表，点哪台就控制哪台；文件/操控/终端都作用于当前设备。
// - 添加设备：配对码 / 扫二维码图片或摄像头 / 自动发现 三种方式。
// - 一句话操控手机由宿主注册的 phone_* Agent 工具完成，面板只是手动兜底。
window.__ModuleLoader__.load({
  id: '@local/dsh-phone-remote',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const PHONE_ID = '@local/dsh-phone-remote'
    const PHONE_KIND = 'phoneRemote'
    const API = '/api/phone-remote'

    const DICT = {
      zh: {
        'tab.title': '手机遥控',
        'guide.title': '手机遥控',
        'guide.description': '一句话让我直接操作手机；面板里可管多台、扫码或配对码添加新手机。',
        'dev.title': '设备',
        'dev.refresh': '刷新',
        'dev.empty': '还没有设备，用下面的「添加设备」连一台。',
        'dev.current': '当前控制',
        'dev.select': '控制这台',
        'dev.remove': '移除',
        'add.title': '添加设备',
        'add.pair': '配对码',
        'add.scan': '扫码',
        'add.discover': '自动发现',
        'add.pairAddr': '配对地址（IP:端口）',
        'add.pairCode': '6 位配对码',
        'add.pairBtn': '配对并连接',
        'add.pairHint': '手机：设置 → 开发者选项 → 无线调试 → 使用配对码配对设备',
        'add.scanBtn': '选择二维码图片',
        'add.scanCam': '用摄像头扫',
        'add.scanStop': '关闭摄像头',
        'add.scanHint': '选手机上的配对二维码，识别后自动配对连接；或让我直接用 phone_pair 工具配对。',
        'add.scanText': '识别内容',
        'add.gen': '生成当前地址二维码',
        'add.genEmpty': '先连接一台设备再生成',
        'add.discoverBtn': '扫描局域网',
        'add.connectBtn': '连接',
        'add.pairingNote': '需要手机停在“配对设备”页面',
        'conn.none': '未选择设备',
        'conn.hint': '在下面添加并选择一台手机',
        'conn.noAdb': '没找到 adb，请在插件配置里设置 adbPath',
        'tab.files': '文件',
        'tab.control': '操控',
        'tab.terminal': '终端',
        'files.dest': '接收目录',
        'files.send': '发送文件',
        'files.sendSub': '选电脑上的文件传来',
        'files.install': '安装 APK',
        'files.installSub': '选 .apk 直接装',
        'files.refresh': '刷新目录',
        'files.empty': '还没有文件列表，点「刷新目录」看看。',
        'ctl.screencap': '截图',
        'ctl.shotHint': '点「截图」查看手机当前画面',
        'ctl.keys': '系统按键',
        'ctl.text': '输入文本',
        'ctl.textPlaceholder': '要输入到手机的文字',
        'ctl.send': '发送',
        'ctl.launch': '启动应用',
        'ctl.launchPlaceholder': '包名，如 com.fizzdragon.mobile.cn.preview',
        'ctl.launchBtn': '启动',
        'ctl.tap': '点击坐标',
        'ctl.tapBtn': '点击',
        'key.back': '返回', 'key.home': '主页', 'key.recents': '多任务',
        'key.power': '电源', 'key.volUp': '音量+', 'key.volDown': '音量−',
        'term.placeholder': '在手机上执行的 shell 命令',
        'term.run': '执行',
        'term.hint': '输出会显示在这里',
        'busy.uploading': '上传中',
        'busy.installing': '安装中，大包可能要几分钟',
        'busy.working': '处理中…',
        'msg.requestFailed': '请求失败',
        'msg.disconnected': '已移除',
        'msg.connected': '连接成功',
        'msg.paired': '配对成功',
        'msg.sent': '已发送',
        'msg.done': '完成',
        'msg.scanOk': '扫码成功',
        'msg.scanFail': '扫码失败',
      },
      en: {
        'tab.title': 'Phone Remote',
        'guide.title': 'Phone Remote',
        'guide.description': 'Ask me to drive the phone; manage multiple phones and add new ones by pairing code or QR in the panel.',
        'dev.title': 'Devices',
        'dev.refresh': 'Refresh',
        'dev.empty': 'No device yet — add one below.',
        'dev.current': 'Active',
        'dev.select': 'Control',
        'dev.remove': 'Remove',
        'add.title': 'Add device',
        'add.pair': 'Pairing code',
        'add.scan': 'QR scan',
        'add.discover': 'Auto discover',
        'add.pairAddr': 'Pairing address (IP:port)',
        'add.pairCode': '6-digit pairing code',
        'add.pairBtn': 'Pair & connect',
        'add.pairHint': 'Phone: Settings → Developer options → Wireless debugging → Pair device with pairing code',
        'add.scanBtn': 'Choose QR image',
        'add.scanCam': 'Scan with camera',
        'add.scanStop': 'Stop camera',
        'add.scanHint': 'Pick the pairing QR from the phone; it pairs automatically. Or ask me to use phone_pair.',
        'add.scanText': 'Decoded',
        'add.gen': 'QR of current address',
        'add.genEmpty': 'Connect a device first',
        'add.discoverBtn': 'Scan LAN',
        'add.connectBtn': 'Connect',
        'add.pairingNote': 'Phone must stay on the “Pair device” screen',
        'conn.none': 'No device selected',
        'conn.hint': 'Add and select a phone below',
        'conn.noAdb': 'adb not found; set adbPath in plugin config',
        'tab.files': 'Files',
        'tab.control': 'Control',
        'tab.terminal': 'Terminal',
        'files.dest': 'Destination',
        'files.send': 'Send file',
        'files.sendSub': 'Pick a file from this computer',
        'files.install': 'Install APK',
        'files.installSub': 'Pick an .apk to install',
        'files.refresh': 'Refresh dir',
        'files.empty': 'No listing yet — tap Refresh dir.',
        'ctl.screencap': 'Screenshot',
        'ctl.shotHint': 'Tap Screenshot to see the phone screen',
        'ctl.keys': 'System keys',
        'ctl.text': 'Send text',
        'ctl.textPlaceholder': 'Text to type on the phone',
        'ctl.send': 'Send',
        'ctl.launch': 'Launch app',
        'ctl.launchPlaceholder': 'Package name, e.g. com.fizzdragon.mobile.cn.preview',
        'ctl.launchBtn': 'Launch',
        'ctl.tap': 'Tap at',
        'ctl.tapBtn': 'Tap',
        'key.back': 'Back', 'key.home': 'Home', 'key.recents': 'Recents',
        'key.power': 'Power', 'key.volUp': 'Vol +', 'key.volDown': 'Vol −',
        'term.placeholder': 'Shell command to run on the phone',
        'term.run': 'Run',
        'term.hint': 'Output appears here',
        'busy.uploading': 'Uploading',
        'busy.installing': 'Installing; large APKs can take minutes',
        'busy.working': 'Working…',
        'msg.requestFailed': 'Request failed',
        'msg.disconnected': 'Removed',
        'msg.connected': 'Connected',
        'msg.paired': 'Paired',
        'msg.sent': 'Sent',
        'msg.done': 'Done',
        'msg.scanOk': 'QR decoded',
        'msg.scanFail': 'QR scan failed',
      },
    }

    const C = {
      text: 'var(--dsw-alias-label-primary, #1b1b1b)',
      text2: 'var(--dsw-alias-label-secondary, #5b5b5b)',
      text3: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      layer: 'var(--dsw-alias-bg-layer-1, #f6f6f7)',
      layer2: 'var(--dsw-alias-bg-layer-2, #fbfbfc)',
      border: 'var(--dsw-alias-border-l2, #e6e6e8)',
      border3: 'var(--dsw-alias-border-l3, #d9d9dc)',
      hover: 'var(--dsw-alias-interactive-bg-hover, #f0f0f1)',
      primary: 'var(--dsw-alias-state-business-primary, #2b6cff)',
      danger: 'var(--dsw-alias-state-error-primary, #d9363e)',
      ok: '#22a06b',
      radius: 'var(--dsw-radius-md, 10px)',
      radiusSm: 'var(--dsw-radius-sm, 7px)',
    }

    function Ic(props) {
      const s = props.size || 16
      const p = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flex: '0 0 auto' } }
      const kids = {
        refresh: [h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.34-5.66' }), h('polyline', { key: 'b', points: '20 4 20 10 14 10' })],
        link: [h('path', { key: 'a', d: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1' }), h('path', { key: 'b', d: 'M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1' })],
        unlink: [h('path', { key: 'a', d: 'M9 15l-1.5 1.5a3.5 3.5 0 0 1-5-5L4 10' }), h('path', { key: 'b', d: 'M15 9l1.5-1.5a3.5 3.5 0 0 1 5 5L20 14' }), h('line', { key: 'c', x1: 3, y1: 3, x2: 21, y2: 21 })],
        folder: [h('path', { key: 'a', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })],
        apk: [h('rect', { key: 'a', x: 4, y: 4, width: 16, height: 16, rx: 3 }), h('path', { key: 'b', d: 'M12 8v6M9 11l3 3 3-3' })],
        camera: [h('rect', { key: 'a', x: 3, y: 7, width: 18, height: 13, rx: 2.5 }), h('circle', { key: 'b', cx: 12, cy: 13, r: 3.4 })],
        back: [h('path', { key: 'a', d: 'M15 18l-6-6 6-6' })],
        up: [h('path', { key: 'a', d: 'M6 15l6-6 6 6' })],
        down: [h('path', { key: 'a', d: 'M6 9l6 6 6-6' })],
        left: [h('path', { key: 'a', d: 'M15 6l-6 6 6 6' })],
        right: [h('path', { key: 'a', d: 'M9 6l6 6-6 6' })],
        menu: [h('line', { key: 'a', x1: 4, y1: 7, x2: 20, y2: 7 }), h('line', { key: 'b', x1: 4, y1: 12, x2: 20, y2: 12 }), h('line', { key: 'c', x1: 4, y1: 17, x2: 20, y2: 17 })],
        home: [h('path', { key: 'a', d: 'M4 11l8-7 8 7v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' })],
        recents: [h('rect', { key: 'a', x: 5, y: 5, width: 14, height: 14, rx: 2.5 })],
        power: [h('path', { key: 'a', d: 'M12 3v9' }), h('path', { key: 'b', d: 'M7.5 6.5a7 7 0 1 0 9 0' })],
        volUp: [h('path', { key: 'a', d: 'M4 9v6h4l5 4V5L8 9z' }), h('path', { key: 'b', d: 'M16 9a4 4 0 0 1 0 6M18.5 7a7 7 0 0 1 0 10' })],
        volDown: [h('path', { key: 'a', d: 'M4 9v6h4l5 4V5L8 9z' }), h('path', { key: 'b', d: 'M16 9a4 4 0 0 1 0 6' })],
        send: [h('path', { key: 'a', d: 'M4 12l16-8-6 16-3-7-7-1z' })],
        terminal: [h('rect', { key: 'a', x: 3, y: 5, width: 18, height: 14, rx: 2.5 }), h('path', { key: 'b', d: 'M7 10l3 2-3 2M13 15h4' })],
        wifi: [h('path', { key: 'a', d: 'M3 9a15 15 0 0 1 18 0' }), h('path', { key: 'b', d: 'M6 12.5a10 10 0 0 1 12 0' }), h('circle', { key: 'c', cx: 12, cy: 17, r: 1.4, fill: 'currentColor', stroke: 'none' })],
        phone: [h('rect', { key: 'a', x: 6, y: 2.5, width: 12, height: 19, rx: 2.6 }), h('line', { key: 'b', x1: 10.5, y1: 18.2, x2: 13.5, y2: 18.2 })],
        tv: [h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 12, rx: 2 }), h('line', { key: 'b', x1: 9, y1: 20, x2: 15, y2: 20 }), h('line', { key: 'c', x1: 12, y1: 16, x2: 12, y2: 20 })],
        glasses: [h('circle', { key: 'a', cx: 7, cy: 13, r: 3.6 }), h('circle', { key: 'b', cx: 17, cy: 13, r: 3.6 }), h('path', { key: 'c', d: 'M10.6 13c.7-.6 2.1-.6 2.8 0M3.4 12l1.2-2.2M20.6 12l-1.2-2.2' })],
        trash: [h('path', { key: 'a', d: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13' })],
        qr: [h('rect', { key: 'a', x: 3, y: 3, width: 7, height: 7, rx: 1 }), h('rect', { key: 'b', x: 14, y: 3, width: 7, height: 7, rx: 1 }), h('rect', { key: 'c', x: 3, y: 14, width: 7, height: 7, rx: 1 }), h('path', { key: 'd', d: 'M14 14h3v3M20 20h1M17 20v1' })],
        plus: [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })],
        check: [h('polyline', { key: 'a', points: '5 12 10 17 19 7' })],
        keypad: [h('rect', { key: 'a', x: 4, y: 3, width: 16, height: 18, rx: 2.5 }), h('path', { key: 'b', d: 'M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01' })],
        edit: [h('path', { key: 'a', d: 'M4 20h4l10.5-10.5a2 2 0 0 0-3-3L5 17v3z' }), h('path', { key: 'b', d: 'M13.5 6.5l3 3' })],
        devices: [h('rect', { key: 'a', x: 7, y: 2.5, width: 10, height: 19, rx: 2.4 }), h('line', { key: 'b', x1: 10.5, y1: 18, x2: 13.5, y2: 18 })],
        zoom: [h('circle', { key: 'a', cx: 11, cy: 11, r: 6.5 }), h('line', { key: 'b', x1: 16, y1: 16, x2: 20.5, y2: 20.5 }), h('line', { key: 'c', x1: 11, y1: 8.5, x2: 11, y2: 13.5 }), h('line', { key: 'd', x1: 8.5, y1: 11, x2: 13.5, y2: 11 })],
        close: [h('line', { key: 'a', x1: 6, y1: 6, x2: 18, y2: 18 }), h('line', { key: 'b', x1: 18, y1: 6, x2: 6, y2: 18 })],
      }
      return h('svg', p, kids[props.name] || kids.phone)
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: C.text, background: C.bg, fontSize: 13 },
      top: { padding: '12px 12px 6px', flex: '0 0 auto' },
      card: { padding: '10px 12px', background: C.layer, border: `1px solid ${C.border}`, borderRadius: C.radius },
      dot: (on) => ({ width: 9, height: 9, borderRadius: 5, background: on ? C.ok : C.text3, boxShadow: on ? '0 0 0 3px rgba(34,160,107,0.16)' : 'none', flex: '0 0 auto' }),
      sTitle: { fontSize: 13, fontWeight: 600, lineHeight: '18px', color: C.text },
      sSub: { fontSize: 11.5, lineHeight: '16px', color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' },
      iconBtn: (dis) => ({ width: 30, height: 30, flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.border3}`, borderRadius: 8, background: C.bg, color: C.text2, cursor: dis ? 'default' : 'pointer', opacity: dis ? 0.5 : 1 }),
      input: { width: '100%', boxSizing: 'border-box', height: 34, padding: '0 10px', border: `1px solid ${C.border3}`, borderRadius: 8, background: C.bg, color: C.text, fontSize: 13, outline: 'none' },
      primary: (dis) => ({ height: 34, padding: '0 14px', border: '1px solid transparent', borderRadius: 8, background: C.primary, color: '#fff', fontSize: 13, fontWeight: 600, cursor: dis ? 'default' : 'pointer', opacity: dis ? 0.55 : 1, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }),
      ghost: (dis) => ({ height: 34, padding: '0 12px', border: `1px solid ${C.border3}`, borderRadius: 8, background: C.bg, color: C.text, fontSize: 13, cursor: dis ? 'default' : 'pointer', opacity: dis ? 0.5 : 1, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }),
      label: { display: 'block', fontSize: 11.5, color: C.text2, margin: '0 0 6px', fontWeight: 500 },
      section: { fontSize: 11.5, color: C.text2, fontWeight: 600, margin: '14px 0 8px', letterSpacing: 0.2 },
      devRow: (active) => ({ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 8, border: `1px solid ${active ? 'rgba(43,108,255,0.35)' : C.border}`, background: active ? 'rgba(43,108,255,0.06)' : C.bg, cursor: 'pointer', marginBottom: 6 }),
      devName: { fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      devSub: { fontSize: 11, color: C.text3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      miniSeg: { display: 'flex', gap: 4, padding: 3, background: C.layer, border: `1px solid ${C.border}`, borderRadius: 9, marginBottom: 10 },
      miniBtn: (active) => ({ flex: 1, height: 26, border: '1px solid transparent', borderRadius: 6, background: active ? C.bg : 'transparent', color: active ? C.text : C.text2, fontWeight: active ? 600 : 400, fontSize: 12, cursor: 'pointer' }),
      toastBar: { height: 24, boxSizing: 'border-box', flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 12px', fontSize: 11.5, color: C.text2, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
      seg: { display: 'flex', gap: 4, margin: '2px 12px 8px', padding: 4, background: C.layer, border: `1px solid ${C.border}`, borderRadius: 10, flex: '0 0 auto' },
      segBtn: (active) => ({ flex: 1, height: 30, border: active ? `1px solid ${C.border3}` : '1px solid transparent', borderRadius: 7, background: active ? C.bg : 'transparent', color: active ? C.text : C.text2, fontWeight: active ? 600 : 400, fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }),
      body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '4px 12px 16px' },
      tile: { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3, padding: '12px', border: `1px solid ${C.border3}`, borderRadius: C.radiusSm, background: C.bg, color: C.text, cursor: 'pointer', textAlign: 'left', minHeight: 74 },
      tileIcon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, background: 'rgba(43,108,255,0.10)', color: C.primary, marginBottom: 4 },
      tileTitle: { fontSize: 13, fontWeight: 600 },
      tileSub: { fontSize: 11.5, color: C.text3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' },
      grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
      keyBtn: { height: 46, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, border: `1px solid ${C.border3}`, borderRadius: 8, background: C.bg, color: C.text, cursor: 'pointer', fontSize: 11.5 },
      shotBox: { height: 300, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px dashed ${C.border3}`, borderRadius: C.radius, background: C.layer, overflow: 'hidden', color: C.text3, fontSize: 12 },
      shotImg: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      pre: { margin: 0, minHeight: 100, padding: 10, background: C.layer, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: C.text, maxHeight: 280, overflow: 'auto' },
      chip: { padding: '4px 10px', border: `1px solid ${C.border3}`, borderRadius: 999, background: C.bg, fontSize: 12, cursor: 'pointer', color: C.text, fontVariantNumeric: 'tabular-nums' },
      scanThumb: { maxWidth: '100%', maxHeight: 160, borderRadius: 8, border: `1px solid ${C.border}`, display: 'block', marginTop: 8 },
      video: { width: '100%', maxHeight: 200, borderRadius: 8, background: '#000', marginTop: 8, display: 'block' },
    }

    function PhonePanel(props) {
      const dict = DICT[props.locale] || DICT.zh
      const t = (k) => dict[k] || DICT.zh[k] || k

      const [devices, setDevices] = useState([])
      const [active, setActive] = useState(null)
      const [adbFound, setAdbFound] = useState(true)
      const [addr, setAddr] = useState('')
      const [addTab, setAddTab] = useState('pair')
      const [pairAddr, setPairAddr] = useState('')
      const [pairCode, setPairCode] = useState('')
      const [pairCodes, setPairCodes] = useState({})
      const [renameFor, setRenameFor] = useState(null)
      const [renameVal, setRenameVal] = useState('')
      const [lastDiag, setLastDiag] = useState([])
      const [manualAddr, setManualAddr] = useState('')
      const [pendingPair, setPendingPair] = useState(null)
      const [discovery, setDiscovery] = useState({ connect: [], pairing: [] })
      const [chatLog, setChatLog] = useState([])
      const [chatText, setChatText] = useState('')
      const [chatBusy, setChatBusy] = useState(false)
      const [notes, setNotes] = useState([])
      const [companionIp, setCompanionIp] = useState('')
      const [companion, setCompanion] = useState({ running: false, port: 0 })
      const [installProgress, setInstallProgress] = useState(null)
      const [qrPreview, setQrPreview] = useState('')
      const [qrText, setQrText] = useState('')
      const [shareQr, setShareQr] = useState('')
      const [streaming, setStreaming] = useState(false)
      const [camError, setCamError] = useState('')
      const [tab, setTab] = useState('control')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [dest, setDest] = useState('/sdcard/Download/RemoteControl')
      const [listing, setListing] = useState('')
      const [shot, setShot] = useState('')
      const [liveView, setLiveView] = useState(true)
      const [castInfo, setCastInfo] = useState('')
      const [keepAwakeList, setKeepAwakeList] = useState([])
      const [liveAspect, setLiveAspect] = useState(0)
      const [tapPing, setTapPing] = useState(null)
      const [aiText, setAiText] = useState('')
      const [aiBusy, setAiBusy] = useState(false)
      const [aiResult, setAiResult] = useState(null)
      // AIUI 工程部署（Rokid 眼镜真机测试，调用官方 aix）
      const [aixPath, setAixPath] = useState('')
      const [aixOut, setAixOut] = useState('')
      const [aixBusy, setAixBusy] = useState('')
      // 串流的设备（key 列表）：每台设备独立开关，想看哪台看哪台。
      const [streamKeys, setStreamKeys] = useState([])
      const [liveNonce, setLiveNonce] = useState(0)
      const [text, setText] = useState('')
      const [pkg, setPkg] = useState('')
      const [cmd, setCmd] = useState('')
      const [cmdOut, setCmdOut] = useState('')
      const [tapX, setTapX] = useState('')
      const [tapY, setTapY] = useState('')
      const fileRef = useRef(null)
      const apkRef = useRef(null)
      const qrFileRef = useRef(null)
      const videoRef = useRef(null)
      const streamRef = useRef(null)

      const note = (type, text2) => setMsg({ type, text: text2 })
      const api = useCallback(async (path, body) => {
        const resp = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        const data = await resp.json().catch(() => ({ ok: false, error: 'HTTP ' + resp.status }))
        if (!resp.ok || !data.ok) throw new Error(data.error || 'HTTP ' + resp.status)
        return data.value
      }, [])

      const loadDevices = useCallback(async () => {
        try {
          const s = await api('/status', {})
          setAdbFound(s.adbFound !== false)
          setDevices(s.devices || [])
          setActive(s.active || null)
          setNotes(s.notes || [])
          setKeepAwakeList(s.keepAwake || [])
        } catch (e) { note('err', t('msg.requestFailed') + '：' + e.message) }
      }, [api])
      useEffect(() => { loadDevices() }, [loadDevices])

      // 实时刷新设备状态（每 4 秒 + 页面可见/窗口聚焦时立即刷新）
      useEffect(() => {
        let disposed = false
        let inFlight = false
        const tick = async () => {
          if (disposed || inFlight) return
          inFlight = true
          try {
            const s = await api('/status', {})
            if (disposed) return
            setAdbFound(s.adbFound !== false)
            setDevices(s.devices || [])
            setActive(s.active || null)
            setNotes(s.notes || [])
          } catch { /* 轮询失败静默 */ } finally { inFlight = false }
        }
        tick()
        const id = setInterval(tick, 4000)
        const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) tick() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
        if (typeof window !== 'undefined') window.addEventListener('focus', tick)
        return () => {
          disposed = true
          clearInterval(id)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
          if (typeof window !== 'undefined') window.removeEventListener('focus', tick)
        }
      }, [api])

      // 防卡死：任何“处理中”超过 60 秒自动解除，避免一直显示连接中
      useEffect(() => {
        if (!busy) return undefined
        const id = setTimeout(() => { setBusy(''); note('err', '操作超时，请重试（可看「连接详情」）') }, 60000)
        return () => clearTimeout(id)
      }, [busy])

      const activeDevice = devices.find((d) => d.serial === active) || null

      const doSelect = async (serial) => {
        setBusy(t('busy.working'))
        try { await api('/select', { device: serial }); await loadDevices(); note('ok', t('msg.connected') + '：' + serial) }
        catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const doRemove = async (serial) => {
        setBusy(t('busy.working'))
        try { await api('/disconnect', { device: serial }); await loadDevices(); note('ok', t('msg.disconnected')) }
        catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const doReconnect = async (serial) => {
        setBusy(t('busy.working')); setMsg(null)
        try { const v = await api('/reconnect', { device: serial }); await loadDevices(); note('ok', `已重连 → ${v.connected}`) }
        catch (e) { await loadDevices(); note('err', e.message) } finally { setBusy('') }
      }
      const doRename = async (serial, name) => {
        setBusy(t('busy.working'))
        try { await api('/rename', { device: serial, name }); setRenameFor(null); await loadDevices(); note('ok', '已改名') }
        catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const doChatSend = async () => {
        const text = chatText.trim()
        if (!text || chatBusy) return
        // @设备名：设备名可能含空格，所以先按已知设备名做最长匹配。
        const names = devices.map((d) => d.name || d.key).filter(Boolean)
        const targets = []
        let rest = text
        for (const name of names.slice().sort((a, b) => b.length - a.length)) {
          const at = '@' + name
          const index = rest.indexOf(at)
          if (index < 0) continue
          const hit = devices.find((d) => (d.name || d.key) === name)
          if (hit && !targets.includes(hit)) targets.push(hit)
          rest = rest.slice(0, index) + rest.slice(index + at.length)
        }
        if (!targets.length) {
          // 退化：用空格分隔的 @xxx 兜底
          for (const mention of [...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1])) {
            const hit = devices.find((d) => (d.name || '') === mention)
              || devices.find((d) => d.key === mention)
              || devices.find((d) => d.serial === mention)
            if (!hit) { note('err', `没找到手机「${mention}」`); return }
            if (!targets.includes(hit)) targets.push(hit)
          }
        }
        if (!targets.length) { note('err', '请用 @设备名 指定要控制哪台手机'); return }
        setChatBusy(true)
        setChatLog((lines) => [...lines, { role: 'me', text }])
        setChatText('')
        for (const target of targets) {
          const label = target.name || target.key
          // 指令正文里去掉 @设备名，剩下的才是要执行的话。
          const command = rest.replace(/^\s*[:：,，]?\s*/, '').trim() || text.replace(/@\S+\s*/g, '').trim()
          try {
            const v = await api('/command', { device: target.key || target.serial, text: command })
            setChatLog((lines) => [...lines, { role: 'device', device: label, text: v.describe + (v.output ? '：' + String(v.output).trim().slice(0, 400) : ' ✓'), dataUrl: v.dataUrl }])
          } catch (e) {
            setChatLog((lines) => [...lines, { role: 'error', device: label, text: e.message }])
          }
        }
        await loadDevices()
        setChatBusy(false)
      }
      const doAdbReset = async () => {
        setBusy('重置 adb 服务…')
        try { await api('/adb-reset', {}); await loadDevices(); note('ok', 'adb 服务已重启，请重新连接') }
        catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const doCompanionProbe = async (ip) => {
        const target = (ip ?? companionIp).trim()
        if (!target) { note('err', '请输入手机的局域网 IP'); return }
        setBusy('探测手机 App 服务…'); setMsg(null)
        try {
          const v = await api('/companion', { ip: target })
          setCompanionIp(target)
          setCompanion(v)
          if (v.running) note('ok', `App 服务在运行：${v.ip}:${v.port}`)
          else note('err', '没找到 App 的控制服务：请确认手机上「手机遥控伴侣」的无障碍已开启')
        } catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const doConnect = async (address, pairing = null) => {
        if (busy) return
        const target = (address ?? addr).trim()
        const port = target.slice(target.lastIndexOf(':') + 1)
        if (pairing && (!target.startsWith(`${pairing.host}:`) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || target === pairing.address)) {
          note('err', `请填同一台手机「无线调试」主页面上的连接地址（${pairing.host}:端口）。`)
          return
        }
        if (address !== undefined && !target) { note('err', '请输入手机的连接地址'); return }
        setBusy(t('busy.working')); setMsg(null)
        try {
          const v = await api('/connect', { address: target })
          if (pairing || v.target.startsWith(`${pendingPair?.host}:`)) setPendingPair(null)
          setAddr(''); setManualAddr('')
          if (pairing) setLastDiag((lines) => [...lines, `连接 ${v.target}：已在线`])
          await loadDevices()
          note('ok', `${t('msg.connected')}：${v.model || ''} ${v.target}`.trim())
        } catch (e) {
          if (pairing) setLastDiag((lines) => [...lines, e.message])
          note('err', e.message)
        } finally { setBusy('') }
      }
      const doPair = () => doPairWith(pairAddr, pairCode)
      const doPairWith = async (address, code) => {
        if (busy) return
        const pairingAddress = String(address || '').trim()
        if (!/^\S+:\d{1,5}$/.test(pairingAddress)) { note('err', '请输入手机配对弹窗上的 IP 地址和端口'); return }
        if (!/^\d{6}$/.test(String(code || '').trim())) { note('err', '请输入手机显示的 6 位配对码'); return }
        setBusy(t('busy.working')); setMsg(null); setLastDiag(['正在配对…'])
        try {
          const connectionAddress = pendingPair ? '' : manualAddr.trim()
          const v = await api('/pair', { address: pairingAddress, code: String(code).trim(), connectionAddress })
          setLastDiag(v.diag || [])
          if (v.paired === false) { note('err', '配对失败：' + (v.error || '')); return }
          setPairCode('')
          setPairCodes((codes) => ({ ...codes, [pairingAddress]: '' }))
          if (v.connected) {
            setPendingPair(null)
            setManualAddr('')
            note('ok', `配对并连接成功：${v.connected}`)
          } else {
            const host = pairingAddress.slice(0, pairingAddress.lastIndexOf(':'))
            setManualAddr(connectionAddress || `${host}:`)
            setPendingPair({ address: pairingAddress, host })
            note('err', '配对已完成。请在面板里填写主页面的连接端口。')
          }
          await loadDevices()
        } catch (e) { setLastDiag([e.message]); note('err', e.message) } finally { setBusy('') }
      }
      const doDiscover = async () => {
        setBusy(t('busy.working'))
        try {
          const v = await api('/discover', {})
          setDiscovery({ connect: v.connect || [], pairing: v.pairing || [] })
          if (!v.connect?.length && !v.pairing?.length) note('err', '没发现设备：请让手机停在「使用配对码配对设备」页面（保持亮屏）再扫一次')
        } catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const sendQrBlob = async (blob) => {
        setBusy(t('busy.working')); setMsg(null); setQrText('')
        try {
          const resp = await fetch(API + '/qr', { method: 'POST', body: blob })
          const data = await resp.json().catch(() => ({ ok: false, error: 'HTTP ' + resp.status }))
          if (!resp.ok || !data.ok) throw new Error(data.error || 'HTTP ' + resp.status)
          const v = data.value
          if (!v.decoded) { note('err', t('msg.scanFail') + '：' + (v.error || '')); return }
          setQrText(v.text || '')
          if (v.acted) { await loadDevices(); note('ok', `${t('msg.scanOk')}：${v.acted.connected || v.acted.target || ''}`.trim()) }
          else if (v.actionError) { note('err', '扫码内容：' + v.text + '；执行失败：' + v.actionError) }
          else { note('ok', t('msg.scanOk')) }
        } catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const onPickQr = (e) => {
        const f = e.target.files && e.target.files[0]
        if (!f) return
        const reader = new FileReader()
        reader.onload = () => setQrPreview(String(reader.result || ''))
        reader.readAsDataURL(f)
        sendQrBlob(f)
        if (qrFileRef.current) qrFileRef.current.value = ''
      }
      const startCam = async () => {
        setCamError('')
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
          streamRef.current = stream
          setStreaming(true)
        } catch (e) { setCamError('无法打开摄像头：' + (e.message || e)); setStreaming(false) }
      }
      const stopCam = () => {
        if (streamRef.current) { streamRef.current.getTracks().forEach((tr) => tr.stop()); streamRef.current = null }
        setStreaming(false)
      }
      useEffect(() => () => { if (streamRef.current) streamRef.current.getTracks().forEach((tr) => tr.stop()) }, [])
      useEffect(() => {
        if (streaming && videoRef.current && streamRef.current) {
          videoRef.current.srcObject = streamRef.current
          videoRef.current.play().catch(() => {})
        }
      }, [streaming])
      const captureCam = () => {
        const video = videoRef.current
        if (!video || !video.videoWidth) { note('err', '摄像头还没就绪'); return }
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth; canvas.height = video.videoHeight
        canvas.getContext('2d').drawImage(video, 0, 0)
        canvas.toBlob((blob) => { if (blob) { setQrPreview(canvas.toDataURL('image/png')); sendQrBlob(blob); stopCam() } }, 'image/png')
      }
      const genQr = async () => {
        const target = activeDevice || devices.find((d) => d.state === 'device')
        if (!target) { note('err', t('add.genEmpty')); return }
        setBusy(t('busy.working'))
        try { const v = await api('/qrgen', { text: target.serial }); setShareQr(v.dataUrl) }
        catch (e) { note('err', e.message) } finally { setBusy('') }
      }

      const uploadOne = (file, install) => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        // 是否安装完全由调用方决定（「发送文件」=false 走 push，「安装 APK」=true 走 install）。
        // 绝不靠 .apk 后缀判断——否则「发送文件」里发 APK 会被误当成安装、手机里找不到文件。
        const isInstall = Boolean(install)
        // 安装走「任务 + 轮询」：能显示真实进度（上传百分比 + 安装阶段）。
        if (isInstall) {
          xhr.open('POST', API + '/install-start')
          xhr.setRequestHeader('x-filename', encodeURIComponent(file.name))
          if (targetId) xhr.setRequestHeader('x-device', targetId)
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return
            const pct = Math.round((e.loaded / e.total) * 100)
            setInstallProgress({ pct, phase: 'uploading', message: `正在上传 ${pct}%（${(e.loaded / 1048576).toFixed(1)}/${(e.total / 1048576).toFixed(1)} MB）` })
          }
          xhr.onload = () => {
            let data = null
            try { data = JSON.parse(xhr.responseText) } catch { /* ignore */ }
            if (!xhr.status || xhr.status >= 400 || !data || !data.ok) { reject(new Error((data && data.error) || 'HTTP ' + xhr.status)); return }
            const jobId = data.value.jobId
            const poll = async () => {
              try {
                const st = await api('/install-status', { jobId })
                setInstallProgress({ pct: st.progress, phase: st.phase, message: st.message })
                if (st.done) {
                  if (st.ok) resolve({ installed: true, filename: st.filename, bytes: st.bytes })
                  else reject(new Error(st.error || '安装失败'))
                  return
                }
                setTimeout(poll, 900)
              } catch (e) { reject(e) }
            }
            poll()
          }
          xhr.onerror = () => reject(new Error('网络错误'))
          xhr.send(file)
          return
        }
        xhr.open('POST', API + '/upload')
        xhr.setRequestHeader('x-filename', encodeURIComponent(file.name))
        xhr.setRequestHeader('x-dest', dest)
        xhr.setRequestHeader('x-install', '0')
        if (targetId) xhr.setRequestHeader('x-device', targetId)
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const pct = Math.round((e.loaded / e.total) * 100); setBusy(`${t('busy.uploading')} ${pct}%`); setInstallProgress({ pct, phase: 'uploading', message: `正在发送 ${pct}%（${(e.loaded / 1048576).toFixed(1)}/${(e.total / 1048576).toFixed(1)} MB）` }) } }
        xhr.onload = () => { try { const d = JSON.parse(xhr.responseText); if (!xhr.status || xhr.status >= 400 || !d.ok) reject(new Error(d.error || 'HTTP ' + xhr.status)); else resolve(d.value) } catch { reject(new Error('响应解析失败')) } }
        xhr.onerror = () => reject(new Error('网络错误'))
        xhr.send(file)
      })
      const sendFiles = async (list, install) => {
        if (!list || !list.length) return
        setMsg(null)
        // 发送和安装都显示进度条，避免「点了没反应」的错觉。
        setInstallProgress({ pct: 0, phase: 'uploading', message: install ? '准备安装…' : '准备发送…' })
        try { const results = []; for (const f of list) results.push(await uploadOne(f, install)); const last = results[results.length - 1]
          note('ok', install ? `已安装：${last.filename}（${(last.bytes / 1048576).toFixed(1)} MB）` : `已发送 ${results.length} 个 → ${last.remote}\n手机里位置：${last.remote}\n（文件管理里进入 Download/RemoteControl 文件夹即可找到）`)
          if (!install) { try { const v = await api('/list', { path: dest, device: targetId }); setListing(v.listing) } catch { /* ignore */ } }
        } catch (e) { note('err', e.message) } finally { setBusy(''); setInstallProgress(null); if (fileRef.current) fileRef.current.value = ''; if (apkRef.current) apkRef.current.value = '' }
      }
      const refreshDir = async () => { setBusy(t('busy.working')); try { const v = await api('/list', { path: dest, device: targetId }); setListing(v.listing) } catch (e) { note('err', e.message) } finally { setBusy('') } }
      const doScreencap = async () => { setBusy(t('busy.working')); try { const v = await api('/screencap', { device: targetId }); setShot(v.dataUrl); setMsg(null) } catch (e) { note('err', e.message) } finally { setBusy('') } }
      const doKey = async (name) => { setBusy(t('busy.working')); try { await api('/input', { kind: 'key', name, device: targetId }) } catch (e) { note('err', e.message) } finally { setBusy('') } }
      const doText = async () => { if (!text.trim()) return; setBusy(t('busy.working')); try { await api('/input', { kind: 'text', text, device: targetId }); note('ok', t('msg.sent')) } catch (e) { note('err', e.message) } finally { setBusy('') } }
      const doLaunch = async () => { if (!pkg.trim()) return; setBusy(t('busy.working')); try { await api('/launch', { package: pkg.trim(), device: targetId }); note('ok', t('msg.done')) } catch (e) { note('err', e.message) } finally { setBusy('') } }
      const doTap = async () => { setBusy(t('busy.working')); try { await api('/input', { kind: 'tap', x: Number(tapX), y: Number(tapY), device: targetId }); note('ok', t('msg.done')) } catch (e) { note('err', e.message) } finally { setBusy('') } }
      const doCmd = async () => { if (!cmd.trim()) return; setBusy(t('busy.working')); try { const v = await api('/shell', { command: cmd, device: targetId }); setCmdOut(`$ ${cmd}\n${v.stdout}${v.stderr ? '\n[stderr] ' + v.stderr : ''}${v.code ? '\n[exit ' + v.code + ']' : ''}`) } catch (e) { setCmdOut('$ ' + cmd + '\n' + e.message) } finally { setBusy('') } }
      const doCast = async () => { setBusy('cast'); setCastInfo(''); try { const v = await api('/cast', { device: targetId, mode: 'computer' }); setCastInfo(v.hint || '电视已切到电脑投屏。') } catch (e) { setCastInfo('投屏失败：' + e.message); note('err', e.message) } finally { setBusy('') } }
      const doKeepAwake = async (on) => {
        if (!targetId) return
        setBusy('keepawake')
        try { await api('/keepawake', { device: targetId, on }); await loadDevices(); note('ok', on ? '已开启防休眠' : '已关闭防休眠') }
        catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const doAi = async () => {
        if (!targetId) { note('err', '请先选择设备'); return }
        if (!aiText.trim()) return
        setAiBusy(true); setAiResult(null)
        try { const v = await api('/ai', { device: targetId, text: aiText.trim() }); setAiResult(v); setAiText('') }
        catch (e) { note('err', e.message); setAiResult({ error: e.message }) } finally { setAiBusy(false) }
      }
      const toggleStream = (id) => setStreamKeys((ks) => ks.includes(id) ? ks.filter((x) => x !== id) : [...ks, id])
      const doAix = async (action) => {
        if (!targetId) { note('err', '请先连接眼镜'); return }
        if (!aixPath.trim()) { note('err', '请填写本地 AIUI 工程目录或 .aix 文件路径'); return }
        setAixBusy(action); setAixOut('正在' + (action === 'launch' ? '打开页面…' : action === 'show' ? '查看定义…' : action === 'check' ? '静态检查…' : '部署到眼镜…'))
        try {
          const v = await api('/aix-deploy', { device: targetId, action, path: aixPath.trim() })
          setAixOut((v.ok ? '✅ ' : '❌ ') + (v.output || '(无输出)'))
          note(v.ok ? 'ok' : 'err', v.ok ? 'AIUI 操作完成' : 'AIUI 操作失败')
        } catch (e) { setAixOut('❌ ' + e.message); note('err', e.message) } finally { setAixBusy('') }
      }
      const doAixInfo = async () => {
        if (!targetId) return
        setAixBusy('device'); setAixOut('读取眼镜 AIUI 状态…')
        try { const v = await api('/aix-device', { device: targetId }); setAixOut(v.output || '(无输出)') }
        catch (e) { setAixOut('❌ ' + e.message) } finally { setAixBusy('') }
      }
      const doPcStream = async () => {
        if (!targetId) { note('err', '请先选择目标设备'); return }
        setBusy('pcstream')
        try { const v = await api('/pcstream', { device: targetId }); note('ok', v.note || '已把电脑画面推过去'); setCastInfo(v.note || '') }
        catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const doBridge = async (toId) => {
        if (!targetId) { note('err', '请先选择来源设备'); return }
        setBusy('bridge')
        try { const v = await api('/bridge', { from: targetId, to: toId }); note('ok', v.note || '已转串流'); setCastInfo(v.url || '') }
        catch (e) { note('err', e.message) } finally { setBusy('') }
      }
      const doTapFrac = async (e) => {
        if (!targetDevice || targetDevice.state !== 'device') return
        const rect = e.currentTarget.getBoundingClientRect()
        const fx = (e.clientX - rect.left) / rect.width
        const fy = (e.clientY - rect.top) / rect.height
        if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return
        setTapPing({ x: e.clientX - rect.left, y: e.clientY - rect.top, t: Date.now() })
        try { await api('/tapfrac', { device: targetId, fx, fy }) } catch (err) { note('err', err.message) }
        setTimeout(() => setTapPing(null), 500)
      }

      const disabled = Boolean(busy)
      const camSupported = (() => { try { return typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function' } catch { return false } })()

      // 多设备并行：操控/文件/终端各自作用于「本次选中的那台」，不再强制全局唯一目标。
      const [targetKey, setTargetKey] = useState(null)
      const onlineDevices = devices.filter((d) => d.state === 'device')
      const targetDevice = useMemo(() => {
        const wanted = targetKey
        if (wanted) {
          const hit = devices.find((d) => (d.key || d.serial) === wanted)
          if (hit) return hit
        }
        const activeHit = devices.find((d) => d.serial === active)
        if (activeHit) return activeHit
        return onlineDevices[0] || null
      }, [devices, targetKey, active, onlineDevices])
      const targetId = targetDevice ? (targetDevice.key || targetDevice.serial) : ''
      const targetLabel = targetDevice ? (targetDevice.name || targetDevice.model || targetDevice.key) : ''

      // ---- 头部：左上设备列表 / 右上连接设备，都可点开成抽屉 ----
      // （header 在 deviceSection / addSection 定义之后才创建，见文件末尾。）
      const [drawer, setDrawer] = useState(null)   // 'devices' | 'connect' | null

      const drawerPanel = (kind, title, content) => {
        if (drawer !== kind) return null
        return h('div', {
          style: {
            // fixed 铺满整个浏览器窗口，而不是缩在窄窄的右侧栏里。
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'stretch', justifyContent: 'center',
          },
          onClick: (e) => { if (e.target === e.currentTarget) setDrawer(null) },
        },
          h('div', {
            style: {
              width: '100%', maxWidth: 560, height: '100%', maxHeight: '100%',
              background: C.bg, boxShadow: '0 0 40px rgba(0,0,0,0.5)',
              display: 'flex', flexDirection: 'column', minHeight: 0,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: `1px solid ${C.border}`, flex: '0 0 auto' } },
              h('div', { style: { fontSize: 15, fontWeight: 700, flex: '1 1 auto' } }, title),
              h('button', { style: { ...S.iconBtn(disabled), width: 32, height: 32 }, title: '关闭', 'aria-label': '关闭', onClick: () => setDrawer(null) }, h(Ic, { name: 'close', size: 16 })),
            ),
            h('div', { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 16px 24px' } }, content),
          ),
        )
      }

      const toastText = busy || (msg ? msg.text : '')
      const toast = h('div', { style: { ...S.toastBar, color: msg && msg.type === 'err' && !busy ? C.danger : C.text2, fontWeight: busy ? 500 : 400 } }, toastText)

      // ---- 设备列表 ----
      const deviceRows = devices.length
        ? devices.map((d) => {
            const online = d.state === 'device'
            const renaming = renameFor === d.key || renameFor === d.serial
            const label = d.name || d.model || d.key || 'Android'
            const sub = d.name && d.model ? `${d.model}  ·  ${d.serial}  ·  ${online ? '在线' : '离线'}` : `${d.serial}  ·  ${online ? '在线' : '离线'}`
            const note = notes.find((n) => n.key === d.key)
            return h('div', { key: d.key || d.serial, style: { marginBottom: 6 } },
              h('div', { style: { ...S.devRow(d.serial === active), marginBottom: 0 }, onClick: () => { if (online && !renaming) doSelect(d.serial) } },
                h('span', { style: S.dot(online) }),
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                  h('div', { style: S.devName }, label),
                  h('div', { style: S.devSub }, sub),
                  note ? h('div', { style: { fontSize: 10.5, color: C.text3, marginTop: 2 } }, note.reason) : null,
                ),
                h('button', { style: { ...S.iconBtn(disabled), width: 26, height: 26, marginRight: 2 }, title: '改名', onClick: (e) => { e.stopPropagation(); setRenameFor(d.key || d.serial); setRenameVal(label) }, disabled }, h(Ic, { name: 'edit', size: 14 })),
                online
                  ? (d.serial === active
                      ? h('span', { style: { fontSize: 11, color: C.primary, fontWeight: 600 } }, t('dev.current'))
                      : h('button', { style: { ...S.ghost(disabled), height: 26, padding: '0 10px' }, onClick: (e) => { e.stopPropagation(); doSelect(d.serial) }, disabled }, '用这台'))
                  : h('button', { style: { ...S.primary(disabled), height: 26, padding: '0 12px' }, onClick: (e) => { e.stopPropagation(); doReconnect(d.serial) }, disabled }, '重连'),
                h('button', { style: { ...S.iconBtn(disabled), width: 26, height: 26 }, title: t('dev.remove'), onClick: (e) => { e.stopPropagation(); doRemove(d.serial) }, disabled }, h(Ic, { name: 'trash', size: 14 })),
              ),
              renaming ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0 0' } },
                h('input', { style: { ...S.input, height: 30 }, placeholder: '设备名字', value: renameVal, autoFocus: true, onChange: (e) => setRenameVal(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doRename(d.key || d.serial, renameVal) } }),
                h('button', { style: { ...S.primary(disabled), height: 30, padding: '0 12px' }, onClick: () => doRename(d.key || d.serial, renameVal), disabled }, '保存'),
                h('button', { style: { ...S.ghost(disabled), height: 30, padding: '0 10px' }, onClick: () => setRenameFor(null), disabled }, '取消'),
              ) : null,
            )
          })
        : [h('div', { key: 'empty', style: { fontSize: 11.5, color: C.text3, padding: '4px 2px' } }, t('dev.empty'))]

      const deviceSection = h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 8px' } },
          h('div', { style: { ...S.section, margin: 0 } }, t('dev.title') + ` (${devices.length})`),
        ),
        ...deviceRows,
      )

      // ---- 添加设备 ----
      const pairPane = h('div', null,
        h('label', { style: S.label }, '配对弹窗里的 IP 地址和端口',
          h('input', { style: S.input, placeholder: '192.168.1.50:37221', value: pairAddr, onChange: (e) => setPairAddr(e.target.value) })),
        h('label', { style: { ...S.label, marginTop: 10 } }, '6 位配对码',
          h('input', { style: S.input, inputMode: 'numeric', maxLength: 6, value: pairCode, onChange: (e) => setPairCode(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doPair() } })),
        h('button', { style: { ...S.primary(disabled), width: '100%', marginTop: 12 }, onClick: doPair, disabled }, h(Ic, { name: 'link' }), '配对并连接'),
      )

      const scanPane = h('div', null,
        h('div', { style: S.row },
          h('button', { style: { ...S.primary(disabled), flex: '1 1 auto' }, onClick: () => qrFileRef.current && qrFileRef.current.click(), disabled }, h(Ic, { name: 'qr' }), t('add.scanBtn')),
          camSupported ? h('button', { style: S.ghost(disabled), onClick: streaming ? stopCam : startCam, disabled }, h(Ic, { name: 'camera' }), t(streaming ? 'add.scanStop' : 'add.scanCam')) : null,
        ),
        h('input', { ref: qrFileRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: onPickQr }),
        camSupported ? null : h('div', { style: { fontSize: 11, color: C.text3, marginTop: 8, lineHeight: 1.5 } }, '当前环境不支持摄像头扫码，请用「选择二维码图片」（可先截图再选）。'),
        h('div', { style: { fontSize: 11, color: C.text3, marginTop: 8, lineHeight: 1.5 } }, t('add.scanHint')),
        camError ? h('div', { style: { fontSize: 11, color: C.danger, marginTop: 6 } }, camError) : null,
        streaming ? h('div', null,
          h('video', { ref: videoRef, style: S.video, playsInline: true, muted: true }),
          h('button', { style: { ...S.ghost(disabled), width: '100%', marginTop: 8 }, onClick: captureCam, disabled }, h(Ic, { name: 'camera' }), t('msg.scanOk')),
        ) : null,
        qrPreview ? h('img', { src: qrPreview, style: S.scanThumb, alt: 'qr' }) : null,
        qrText ? h('div', { style: { marginTop: 8 } },
          h('div', { style: S.label }, t('add.scanText')),
          h('pre', { style: { ...S.pre, minHeight: 0 } }, qrText),
        ) : null,
        h('div', { style: { fontSize: 11, color: C.text3, marginTop: 12, lineHeight: 1.55 } },
          '手机扫电脑的二维码配对：Android 的「二维码配对」需要电脑端运行配对服务器，adb 不提供，本版暂不支持；请用上面的「配对码」或「自动发现」来连接新手机。'),
        shareQr ? h('div', { style: { textAlign: 'center', marginTop: 8 } }, h('img', { src: shareQr, style: { width: 140, height: 140, borderRadius: 8, border: `1px solid ${C.border}` }, alt: 'my-qr' })) : null,
      )

      const devRowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 8, marginTop: 6 }
      const discoverPane = h('div', null,
        h('button', { style: { ...S.ghost(disabled), width: '100%' }, onClick: doDiscover, disabled }, h(Ic, { name: 'wifi' }), t('add.discoverBtn')),
        h('details', { style: { marginTop: 10 } },
          h('summary', { style: { cursor: 'pointer', color: C.text } }, '没发现新手机？输入配对弹窗地址'),
          h('div', { style: { marginTop: 8 } }, pairPane),
        ),
        h('div', { role: pendingPair ? 'status' : undefined, style: { marginTop: 12, color: C.text } },
          pendingPair ? '配对已完成，继续连接' : '连接地址（配对时可预填）'),
        h('label', { style: { ...S.label, marginTop: 4 }, htmlFor: 'phone-remote-connect-address' }, '设备 IP:端口（手机填「无线调试」页面的 IP:端口；Rokid 眼镜填 眼镜IP:5555）'),
        h('div', { style: S.row },
          h('input', { id: 'phone-remote-connect-address', style: S.input, placeholder: '192.168.1.50:37123 或 眼镜 192.168.1.80:5555', value: manualAddr, onChange: (e) => setManualAddr(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doConnect(manualAddr, pendingPair) } }),
          h('button', { style: S.primary(disabled), onClick: () => doConnect(manualAddr, pendingPair), disabled }, pendingPair ? '完成连接' : '直接连接'),
        ),
        pendingPair ? h('button', { style: { ...S.ghost(disabled), marginTop: 6 }, disabled, onClick: () => { setPendingPair(null); setManualAddr('') } }, '连接其他手机') : null,
        h('div', { style: { fontSize: 11, color: C.text3, marginTop: 6 } },
          '连不上 / 僵尸连接？ ',
          h('a', { style: { color: C.primary, cursor: 'pointer', textDecoration: 'underline' }, onClick: doAdbReset }, '重置 adb 服务'),
        ),
        (discovery.connect || []).length ? h('div', { style: { marginTop: 10 } },
          h('div', { style: S.label }, '可连接设备'),
          discovery.connect.map((d) => h('div', { key: 'c' + d.address, style: devRowStyle },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: S.devName }, d.label || '设备'),
              h('div', { style: S.devSub }, d.address)),
            h('button', { style: { ...S.ghost(disabled), height: 28, padding: '0 12px' }, onClick: () => doConnect(d.address), disabled }, '连接'),
          )),
        ) : null,
        (discovery.pairing || []).length ? h('div', { style: { marginTop: 12 } },
          h('div', { style: S.label }, '配对服务（输入手机显示的 6 位码即可，无需填地址）'),
          discovery.pairing.map((d) => h('div', { key: 'p' + d.address, style: devRowStyle },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: S.devName }, d.label || '配对服务'),
              h('div', { style: S.devSub }, d.address)),
            h('input', {
              style: { ...S.input, width: 72, flex: '0 0 72px', height: 28, textAlign: 'center', padding: '0 4px' },
              placeholder: '6位码',
              value: pairCodes[d.address] || '',
              onChange: (e) => setPairCodes(Object.assign({}, pairCodes, { [d.address]: e.target.value })),
              onKeyDown: (e) => { if (e.key === 'Enter') doPairWith(d.address, pairCodes[d.address]) },
            }),
            h('button', { style: { ...S.primary(disabled), height: 28, padding: '0 10px' }, onClick: () => doPairWith(d.address, pairCodes[d.address]), disabled }, '配对'),
          )),
        ) : null,
        (!(discovery.connect || []).length && !(discovery.pairing || []).length)
          ? h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 10, lineHeight: 1.5 } },
            '点「扫描局域网」查找。新手机请让它停在「使用配对码配对设备」页面并保持亮屏，再扫一次。')
          : null,
        lastDiag.length ? h('div', { style: { marginTop: 12 } },
          h('div', { style: S.label }, '连接详情（出错时看这里）'),
          h('pre', { style: { ...S.pre, minHeight: 0, maxHeight: 220 } }, lastDiag.join('\n')),
        ) : null,
      )

      const addSection = h('div', { style: { marginTop: 4, padding: 12, background: C.layer2, border: `1px solid ${C.border}`, borderRadius: C.radius } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 } },
          h('span', { style: { display: 'inline-flex', color: C.primary } }, h(Ic, { name: 'plus', size: 16 })),
          h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, '添加设备（配对码）'),
        ),
        discoverPane,
        h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` } },
          h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 6 } }, '用手机 App 直连（不依赖 adb）'),
          h('div', { style: { fontSize: 11, color: C.text3, marginBottom: 8, lineHeight: 1.5 } },
            '手机上装「手机遥控伴侣」并开启无障碍后，这里填手机 IP 就能直接操控。'),
          h('div', { style: S.row },
            h('input', { style: S.input, placeholder: '手机 IP，例如 192.168.1.106', value: companionIp, onChange: (e) => setCompanionIp(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doCompanionProbe() } }),
            h('button', { style: S.primary(disabled), onClick: () => doCompanionProbe(), disabled }, '探测'),
          ),
          companion.running ? h('div', { style: { fontSize: 11.5, color: C.ok, marginTop: 8 } }, `✓ App 服务运行中：${companion.ip}:${companion.port}`) : null,
        ),
      )

      // ---- 顶栏：标题「远程操控」+ 右上角每台在线设备的电量 ----
      const header = h('div', { style: { ...S.top, position: 'relative' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { flex: '1 1 auto', fontSize: 14, fontWeight: 700 } }, '远程操控'),
          h('button', { style: { ...S.iconBtn(disabled), width: 28, height: 28 }, title: '刷新本插件（重载客户端代码）', 'aria-label': '刷新', onClick: () => { try { window.location.reload() } catch { /* ignore */ } } }, h(Ic, { name: 'refresh', size: 15 })),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } },
            onlineDevices.map((d) => d.battery ? h('span', {
              key: 'bat' + d.key,
              title: (d.name || d.model || '设备') + ' 电量' + (d.battery.charging ? '（充电中）' : ''),
              style: { fontSize: 11.5, color: C.text2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
            }, (d.battery.charging ? '⚡' : '🔋') + d.battery.level + '%') : null),
          ),
        ),
        adbFound ? null : h('div', { style: { marginTop: 8, fontSize: 11.5, color: C.danger } }, t('conn.noAdb')),
      )

      const keyBtn = (name, icon, label) => h('button', { key: name, style: S.keyBtn, onClick: () => doKey(name), disabled }, h(Ic, { name: icon, size: 18 }), h('span', null, label))
      const doSwipe = async (x1, y1, x2, y2) => { try { await api('/input', { kind: 'swipe', x1, y1, x2, y2, ms: 200, device: targetId }); note('ok', '已滑动') } catch (e) { note('err', e.message) } }
      const arrowBtn = (label, dx, dy) => h('button', {
        key: 'sw' + label, style: { ...S.keyBtn, fontSize: 16 },
        onClick: () => { const cx = 240, cy = 320, r = 90; doSwipe(cx - dx * r, cy - dy * r, cx + dx * r, cy + dy * r) }, disabled,
      }, label)
      // 多设备切换条：选哪台，下面所有操作就打给哪台。
      // 设备选择在左侧列表完成。发送文件时会显示一个「发到哪台」横幅，避免发错设备。
      const targetPicker = h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.layer, marginBottom: 10, fontSize: 12 } },
        h('span', { style: S.dot(Boolean(targetDevice && targetDevice.state === 'device')) }),
        h('span', { style: { flex: '1 1 auto', fontWeight: 600, color: C.text } }, `发送到：${targetDevice ? (targetDevice.name || targetDevice.model || '设备') : '未选择设备'}${targetDevice && targetDevice.state !== 'device' ? '（离线）' : ''}`),
        h('span', { style: { fontSize: 10.5, color: C.text3, whiteSpace: 'nowrap' } }, targetDevice ? targetDevice.serial : ''),
      )

      const filesBody = h('div', null,
        targetPicker,
        h('label', { style: S.label }, t('files.dest')),
        h('input', { style: S.input, value: dest, onChange: (e) => setDest(e.target.value) }),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 } },
          h('button', { style: S.tile, onClick: () => fileRef.current && fileRef.current.click(), disabled }, h('span', { style: S.tileIcon }, h(Ic, { name: 'folder', size: 18 })), h('span', { style: S.tileTitle }, t('files.send')), h('span', { style: S.tileSub }, t('files.sendSub'))),
          h('button', { style: S.tile, onClick: () => apkRef.current && apkRef.current.click(), disabled }, h('span', { style: S.tileIcon }, h(Ic, { name: 'apk', size: 18 })), h('span', { style: S.tileTitle }, t('files.install')), h('span', { style: S.tileSub }, t('files.installSub'))),
        ),
        h('input', { ref: fileRef, type: 'file', multiple: true, style: { display: 'none' }, onChange: (e) => sendFiles(Array.from(e.target.files || []), false) }),
        h('input', { ref: apkRef, type: 'file', accept: '.apk,application/vnd.android.package-archive', style: { display: 'none' }, onChange: (e) => sendFiles(Array.from(e.target.files || []), true) }),
        installProgress ? h('div', { style: { marginTop: 10, padding: 10, border: `1px solid ${C.border3}`, borderRadius: 8, background: C.layer } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: C.text2, marginBottom: 6 } },
            h('span', null, installProgress.message || '正在处理…'),
            h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${installProgress.pct || 0}%`),
          ),
          h('div', { style: { height: 6, borderRadius: 3, background: C.border, overflow: 'hidden' } },
            h('div', { style: { height: '100%', width: `${installProgress.pct || 0}%`, background: C.primary, transition: 'width 0.25s ease' } }),
          ),
        ) : null,
        h('button', { style: { ...S.ghost(disabled), width: '100%', marginTop: 10 }, onClick: refreshDir, disabled }, h(Ic, { name: 'refresh' }), t('files.refresh')),
        h('pre', { style: { ...S.pre, marginTop: 12 } }, listing || t('files.empty')),
      )

      const curKind = targetDevice
        ? (targetDevice.kind ||
            (/glasses|rg[_-]?glasses|rokid|yodaos/i.test((targetDevice.model || '') + ' ' + (targetDevice.name || '')) ? 'glasses'
              : /tv|电视|盒子|box|mitv/i.test((targetDevice.model || '') + ' ' + (targetDevice.name || '')) ? 'tv' : 'phone'))
        : 'phone'
      const isTv = curKind === 'tv'
      const isGlasses = curKind === 'glasses'
      const keysBlock = isGlasses
        ? h('div', null,
            h('div', { style: S.section }, '镜腿操作'),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
              keyBtn('enter', 'check', '单击'), keyBtn('back', 'back', '双击'),
              keyBtn('dpadUp', 'up', '向前滑动'), keyBtn('dpadDown', 'down', '向后滑动'),
            ),
            h('div', { style: S.section }, '按键 / 音量'),
            h('div', { style: S.grid3 },
              keyBtn('home', 'home', '主页'), keyBtn('volumeUp', 'volUp', '音量+'), keyBtn('volumeDown', 'volDown', '音量-'),
            ),
          )
        : isTv
          ? h('div', null,
              h('div', { style: S.section }, '方向 / 确认'),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, maxWidth: 240, margin: '0 auto' } },
                h('span'), keyBtn('dpadUp', 'up', '上'), h('span'),
                keyBtn('dpadLeft', 'back', '左'),
                h('button', { key: 'ok', style: { ...S.keyBtn, background: C.primary, color: '#fff', border: `1px solid ${C.primary}` }, onClick: () => doKey('dpadCenter'), disabled }, '确定'),
                keyBtn('dpadRight', 'right', '右'),
                h('span'), keyBtn('dpadDown', 'down', '下'), h('span'),
              ),
              h('div', { style: S.section }, '按键'),
              h('div', { style: S.grid3 },
                keyBtn('back', 'back', '返回'), keyBtn('home', 'home', '主页'), keyBtn('menu', 'keypad', '菜单'),
                keyBtn('volumeUp', 'volUp', '音量+'), keyBtn('volumeDown', 'volDown', '音量-'), keyBtn('power', 'power', '电源'),
              ),
            )
          : h('div', null,
              h('div', { style: S.section }, t('ctl.keys')),
              h('div', { style: S.grid3 },
                keyBtn('back', 'back', t('key.back')), keyBtn('home', 'home', t('key.home')), keyBtn('recents', 'recents', t('key.recents')),
                keyBtn('power', 'power', t('key.power')), keyBtn('volumeUp', 'volUp', t('key.volUp')), keyBtn('volumeDown', 'volDown', t('key.volDown')),
              ),
            )

      const controlBody = h('div', null,
        targetPicker,
        keysBlock,
        isGlasses ? h('div', { style: { marginTop: 10, padding: 10, border: `1px solid ${C.border3}`, borderRadius: 8, background: C.layer } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
            h('span', { style: { fontWeight: 600, fontSize: 12 } }, '🧩 AIUI 工程部署（真机测试）'),
            h('button', { style: { ...S.ghost(disabled), height: 24, padding: '0 8px', fontSize: 11 }, onClick: doAixInfo, disabled: !!aixBusy }, '读取眼镜状态'),
          ),
          h('div', { style: { fontSize: 11, color: C.text3, marginBottom: 6, lineHeight: 1.5 } }, '选电脑上的 AIUI 工程目录（含 app.json）或 .aix 文件；云端 AIUI Studio 的工程请先导出到本机。'),
          h('div', { style: S.row },
            h('input', { style: S.input, placeholder: '/Users/you/my-agent 或 ./bundle.aix', value: aixPath, onChange: (e) => setAixPath(e.target.value) }),
            h('button', { style: { ...S.ghost(disabled), whiteSpace: 'nowrap' }, onClick: async () => { try { const v = await api('/pick', { kind: 'folder' }); if (v.ok && v.path) setAixPath(v.path) } catch (e) { note('err', e.message) } }, disabled }, '浏览目录'),
            h('button', { style: { ...S.ghost(disabled), whiteSpace: 'nowrap' }, onClick: async () => { try { const v = await api('/pick', { kind: 'file' }); if (v.ok && v.path) setAixPath(v.path) } catch (e) { note('err', e.message) } }, disabled }, '选 .aix'),
          ),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
            h('button', { style: { ...S.primary(disabled), height: 30 }, onClick: () => doAix('install'), disabled }, aixBusy === 'install' ? '部署中…' : '部署到眼镜'),
            h('button', { style: { ...S.ghost(disabled), height: 30 }, onClick: () => doAix('launch'), disabled }, '打开页面'),
            h('button', { style: { ...S.ghost(disabled), height: 30 }, onClick: () => doAix('show'), disabled }, '查看定义'),
            h('button', { style: { ...S.ghost(disabled), height: 30 }, onClick: () => doAix('check'), disabled }, '检查'),
          ),
          aixOut ? h('pre', { style: { ...S.pre, marginTop: 8, maxHeight: 200, minHeight: 40 } }, aixOut) : null,
        ) : null,
        h('div', { style: S.section }, t('ctl.text')),
        h('div', { style: S.row },
          h('input', { style: S.input, placeholder: t('ctl.textPlaceholder'), value: text, onChange: (e) => setText(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doText() } }),
          h('button', { style: S.ghost(disabled), onClick: doText, disabled }, h(Ic, { name: 'send' }), t('ctl.send')),
        ),
        // ---- 用 AI 操控（把一句话交给本机大模型，模型拆成设备指令执行）----
        h('div', { style: S.section }, '🤖 用 AI 操控'),
        h('div', { style: { fontSize: 11, color: C.text3, lineHeight: 1.5, marginBottom: 6 } },
          `要在${targetLabel || '这台设备'}上做什么？例如「打开B站搜周杰伦」「返回桌面」「把音量调小」。`),
        h('textarea', {
          style: { ...S.input, height: 64, padding: '8px 10px', resize: 'vertical', lineHeight: 1.5 },
          placeholder: '用一句话告诉 AI 要做什么…',
          value: aiText,
          onChange: (e) => setAiText(e.target.value),
        }),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
          h('button', { style: { ...S.primary(aiBusy || !targetId), height: 32 }, onClick: doAi, disabled: aiBusy || !targetId }, aiBusy ? 'AI 思考中…' : '开始'),
        ),
        aiResult ? h('div', { style: { marginTop: 8, padding: 10, border: `1px solid ${C.border3}`, borderRadius: 8, background: C.layer, fontSize: 11.5, lineHeight: 1.6 } },
          aiResult.error
            ? h('span', { style: { color: C.danger } }, '出错：' + aiResult.error)
            : h('div', null,
                h('div', { style: { color: aiResult.summary && aiResult.summary !== '未完成' ? C.ok : C.text3, marginBottom: 4, fontWeight: 600 } }, '🤖 ' + (aiResult.summary || '未完成')),
                (aiResult.steps || []).length
                  ? h('ol', { style: { margin: '4px 0 0 16px', padding: 0 } },
                      (aiResult.steps || []).map((r, i) => h('li', { key: i, style: { color: r.ok ? C.text : C.danger, marginBottom: 3 } },
                        r.see ? h('span', { style: { color: C.text3 } }, `看到「${r.see}」→ `) : null,
                        r.desc)))
                  : h('span', { style: { color: C.text3 } }, '（没有执行任何动作）'),
              ),
        ) : null,
      )

      const terminalBody = h('div', null,
        targetPicker,
        h('div', { style: S.row },
          h('input', { style: S.input, placeholder: t('term.placeholder'), value: cmd, onChange: (e) => setCmd(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doCmd() } }),
          h('button', { style: S.primary(disabled), onClick: doCmd, disabled }, h(Ic, { name: 'terminal' }), t('term.run')),
        ),
        h('pre', { style: { ...S.pre, marginTop: 12 } }, cmdOut || t('term.hint')),
      )

      const chatBody = h('div', null,
        h('div', { style: { fontSize: 11.5, color: C.text3, marginBottom: 8, lineHeight: 1.5 } },
          '在下面的输入框里用 @设备名 开头指挥对应手机，例如：@主力机 打开微信。可以同时 @ 多台。'),
        devices.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
          devices.map((d) => {
            const label = d.name || d.model || d.key || d.serial
            return h('button', {
              key: 'chip' + (d.key || d.serial),
              style: { ...S.chip, opacity: d.state === 'device' ? 1 : 0.55 },
              title: d.serial,
              onClick: () => setChatText((prev) => (prev && !prev.endsWith(' ') ? prev + ' ' : prev) + '@' + label + ' '),
            }, '@' + label + (d.state === 'device' ? '' : '（离线）'))
          }),
        ) : null,
        chatLog.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 } },
          chatLog.map((line, index) => h('div', { key: 'log' + index, style: { padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.border}`, background: line.role === 'me' ? 'rgba(43,108,255,0.06)' : C.layer2 } },
            h('div', { style: { fontSize: 11, color: line.role === 'error' ? C.danger : C.text3, marginBottom: 2 } },
              line.role === 'me' ? '我' : (line.device || '手机')),
            h('div', { style: { fontSize: 12.5, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, line.text),
            line.dataUrl ? h('img', { src: line.dataUrl, style: { ...S.shotImg, marginTop: 6, maxHeight: 220 }, alt: 'shot' }) : null,
          )),
        ) : null,
        h('div', { style: S.row },
          h('input', { style: S.input, placeholder: '@设备名 打开微信', value: chatText, onChange: (e) => setChatText(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doChatSend() } }),
          h('button', { style: S.primary(chatBusy), onClick: doChatSend, disabled: chatBusy }, h(Ic, { name: 'send' }), '发送'),
        ),
      )

      // ---- 主页：三个功能入口（发送文件 / 操控 / 群聊）----
      const homeCard = (icon, title, sub, onClick) => h('button', {
        style: {
          display: 'flex', alignItems: 'center', gap: 12, width: '100%',
          padding: '14px 14px', marginBottom: 10, textAlign: 'left',
          border: `1px solid ${C.border3}`, borderRadius: C.radius, background: C.bg,
          color: C.text, cursor: 'pointer',
        },
        onClick,
      },
        h('span', { style: { ...S.tileIcon, marginBottom: 0, width: 38, height: 38, flex: '0 0 auto' } }, h(Ic, { name: icon, size: 20 })),
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, title),
          h('span', { style: { fontSize: 11.5, color: C.text3 } }, sub),
        ),
      )

      // ===== Pinky 式布局：左设备列表 / 中实时画面 / 右操作 =====
      const curOnline = Boolean(targetDevice && targetDevice.state === 'device')
      const keOn = Boolean(targetDevice && keepAwakeList.includes(targetDevice.serial))

      // 左侧设备列表：只选设备，不带串流按钮，窄一些。
      const kindIcon = (k) => k === 'tv' ? 'tv' : k === 'glasses' ? 'glasses' : 'phone'
      const leftRows = devices.length ? devices.map((d) => {
        const id = d.key || d.serial
        const on = d.state === 'device'
        const chosen = targetDevice && (targetDevice.key || targetDevice.serial) === id
        const nm = d.name || d.model || d.key || 'Android'
        const kd = d.kind || (/tv|电视|盒子|box|mitv/i.test((d.model || '') + ' ' + (d.name || '')) ? 'tv' : 'phone')
        return h('button', {
          key: 'lv' + id,
          style: {
            width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6, boxSizing: 'border-box',
            padding: '6px 7px', marginBottom: 4, borderRadius: 7, cursor: 'pointer',
            border: `1px solid ${chosen ? C.primary : C.border}`, background: chosen ? 'rgba(43,108,255,0.08)' : C.bg, color: C.text,
          },
          title: d.serial,
          onClick: () => setTargetKey(id),
        },
          h('span', { style: { position: 'relative', display: 'inline-flex', flex: '0 0 auto' } },
            h('span', { style: { color: chosen ? C.primary : C.text2 } }, h(Ic, { name: kindIcon(kd), size: 15 })),
            h('span', { style: { position: 'absolute', right: -2, bottom: -2, width: 6, height: 6, borderRadius: 3, background: on ? C.ok : C.text3, border: `1px solid ${C.bg}` } }),
          ),
          h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden' } },
            h('div', { style: { fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, nm),
            h('div', { style: { fontSize: 9.5, color: on ? C.ok : C.text3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, on ? '在线' : '离线'),
          ),
        )
      }) : h('div', { style: { padding: '8px 4px', fontSize: 11, color: C.text3 } }, '还没有设备')

      const leftCol = h('div', { style: { width: 104, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: `1px solid ${C.border}`, padding: '8px 6px' } },
        h('div', { style: { fontSize: 10.5, color: C.text3, fontWeight: 600, margin: '0 2px 6px' } }, `设备 (${devices.length})`),
        h('div', { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0 } }, leftRows),
        h('button', { style: { ...S.ghost(disabled), width: '100%', marginTop: 6, height: 26, fontSize: 11, padding: 0 }, onClick: () => setDrawer('connect') }, '+ 连接'),
      )

      const aspect = liveAspect > 0 ? liveAspect : (isGlasses ? 1 : isTv ? 16 / 9 : 9 / 16)      // 画面固定小尺寸：保证下方控制板一屏能看全，不用滚动。
      const liveMaxW = isGlasses ? 220 : isTv ? 320 : 132
      const liveMaxH = isGlasses ? 220 : isTv ? 180 : 220
      const livePane = !curOnline
        ? h('div', { style: { height: 64, width: '100%', maxWidth: 200, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px dashed ${C.border3}`, borderRadius: C.radius, background: C.layer, color: C.text3, fontSize: 11.5, margin: '0 auto' } },
            targetDevice ? '设备离线' : '请先选择设备')
        : h('div', {
            style: {
              position: 'relative', width: '100%', maxWidth: liveMaxW, maxHeight: liveMaxH,
              aspectRatio: String(aspect), borderRadius: isTv ? 10 : 16, overflow: 'hidden',
              background: '#0d0f12', border: `1px solid ${C.border2}`, margin: '0 auto', cursor: 'crosshair',
            },
            onClick: doTapFrac,
          },
            liveView
              ? h('img', {
                  key: 'live-' + targetId + '-' + liveNonce,
                  src: `${API}/live?device=${encodeURIComponent(targetId || '')}&q=9&n=${liveNonce}`,
                  alt: '实时画面',
                  onLoad: (e) => { if (isGlasses) return; const n = e.currentTarget; if (n.naturalWidth >= 100 && n.naturalHeight >= 100) { const a = n.naturalWidth / n.naturalHeight; if (Math.abs(a - aspect) > 0.02) setLiveAspect(a) } },
                  onError: () => { setTimeout(() => setLiveNonce((x) => x + 1), 2500) },
                  style: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' },
                })
              : h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9aa', fontSize: 11 } }, '点「实时」开始'),
            tapPing ? h('span', { style: { position: 'absolute', left: tapPing.x - 9, top: tapPing.y - 9, width: 18, height: 18, borderRadius: 9, border: '2px solid rgba(43,108,255,0.9)', pointerEvents: 'none' } }) : null,
          )

      const rightHead = h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
        h('button', { style: { ...S.ghost(disabled), height: 26, padding: '0 9px', fontSize: 11.5, flex: '0 0 auto' }, onClick: () => setDrawer(drawer === 'devices' ? null : 'devices'), title: '所有设备' }, '📱 所有设备'),
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: S.sTitle }, targetDevice ? (targetDevice.name || targetDevice.model || '设备') : '未选择设备'),
          h('div', { style: S.sSub }, targetDevice ? `${targetDevice.model || ''} · ${curOnline ? '在线' : '离线'}` : ''),
        ),
        curOnline ? h('button', { style: { ...(keOn ? S.primary(false) : S.ghost(disabled)), height: 26, padding: '0 9px', fontSize: 11.5 }, onClick: () => doKeepAwake(!keOn), disabled: busy === 'keepawake' }, keOn ? '🔆 防休眠' : '防休眠') : null,
        curOnline ? h('button', { style: { ...S.ghost(disabled), height: 26, padding: '0 9px', fontSize: 11.5 }, onClick: () => setLiveView((v) => !v) }, liveView ? '暂停' : '实时') : null,
        curOnline ? h('button', { style: { ...S.ghost(busy === 'pcstream'), height: 26, padding: '0 9px', fontSize: 11.5 }, onClick: doPcStream, disabled: busy === 'pcstream', title: '把这台设备的屏幕显示电脑画面' }, '💻 投电脑') : null,
      )

      const segTabs = h('div', { style: { display: 'flex', gap: 4, padding: 3, background: C.layer, border: `1px solid ${C.border}`, borderRadius: 9, margin: '8px 0' } },
        [['control', '操控'], ['files', '发送文件']].map(([k, lb]) => {
          const on = tab === k
          return h('button', { key: k, style: { flex: 1, height: 26, border: '1px solid transparent', borderRadius: 6, background: on ? C.bg : 'transparent', color: on ? C.text : C.text2, fontWeight: on ? 600 : 400, fontSize: 12, cursor: 'pointer' }, onClick: () => setTab(k) }, lb)
        }),
      )

      const rightCol = h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '8px 10px 10px' } },
        rightHead,
        // 实时画面放在右侧栏顶部，固定小尺寸，下面就是控制板（信息仍在下方）。
        h('div', { style: { flex: '0 0 auto', display: 'flex', justifyContent: 'center', padding: '2px 0 4px' } }, livePane),
        castInfo ? h('div', { style: { fontSize: 11, color: C.text2, lineHeight: 1.5, margin: '0 0 4px' } }, castInfo) : null,
        segTabs,
        h('div', { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' } },
          tab === 'files' ? filesBody : controlBody),
      )

      const body = h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex' } }, leftCol, rightCol)

      // 「所有设备」抽屉：设备列表（每台独立串流开关）+ 转串流 + 群聊。
      // 所有设备：图2 那种卡片网格。每张卡显示画面（串流时）或不串流占位，点卡片选设备。
      const streamRows = devices.map((d) => {
        const id = d.key || d.serial
        const on = d.state === 'device'
        const streaming = streamKeys.includes(id)
        const chosen = targetDevice && (targetDevice.key || targetDevice.serial) === id
        const nm = d.name || d.model || d.key || 'Android'
        const dk = d.kind || (/glasses|rg[_-]?glasses|rokid|yodaos/i.test((d.model || '') + ' ' + (d.name || '')) ? 'glasses' : /tv|电视|盒子|box|mitv/i.test((d.model || '') + ' ' + (d.name || '')) ? 'tv' : 'phone')
        const tv = dk === 'tv'
        return h('div', {
          key: 'st' + id,
          style: { display: 'flex', flexDirection: 'column', borderRadius: 10, cursor: 'pointer', overflow: 'hidden', border: `1.5px solid ${chosen ? C.primary : C.border}`, background: C.bg },
          onClick: () => { setTargetKey(id); setDrawer(null) },
        },
          h('div', { style: { position: 'relative', width: '100%', aspectRatio: dk === 'glasses' ? '1 / 1' : tv ? '16 / 9' : '9 / 16', background: '#0d0f12', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
            streaming && on
              ? h('img', { key: 's-' + id, src: `${API}/live?device=${encodeURIComponent(id)}&q=9`, alt: nm, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: dk === 'glasses' ? 'contain' : 'fill' } })
              : h('button', {
                  style: { background: 'transparent', border: 'none', color: '#5b6472', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: on ? 'pointer' : 'default' },
                  onClick: (e) => { e.stopPropagation(); if (on) toggleStream(id) },
                  disabled: !on,
                  title: on ? '串流这台设备' : '设备离线',
                },
                  h(Ic, { name: on ? kindIcon(dk) : 'unlink', size: 26 }),
                  h('span', { style: { fontSize: 10, color: on ? C.text3 : '#5b6472' } }, on ? '点此串流' : '离线'),
                ),
          ),
          h('div', { style: { padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { color: C.text2, display: 'inline-flex', flex: '0 0 auto' } }, h(Ic, { name: kindIcon(dk), size: 13 })),
            h('span', { style: S.dot(on) }),
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: { fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, nm),
              h('div', { style: { fontSize: 9.5, color: on ? C.ok : C.text3 } }, `${on ? '在线' : '离线'}${d.battery ? ' · ' + d.battery.level + '%' : ''}`),
            ),
            streaming ? h('span', { style: { width: 6, height: 6, borderRadius: 3, background: C.ok } }) : null,
          ),
        )
      })

      const devicesPanel = h('div', null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 } },
          devices.length ? streamRows : h('div', { style: { fontSize: 11.5, color: C.text3 } }, '还没有设备')),
        h('button', { style: { ...S.ghost(disabled), width: '100%', height: 34 }, onClick: () => setDrawer('connect') }, '+ 连接新设备'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 8px' } },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: C.text2 } }, '群聊'),
          h('div', { style: { flex: '1 1 auto', height: 1, background: C.border } })),
        chatBody,
      )

      return h('div', { style: S.root, 'data-phone-remote': '' }, header, toast, body,
        drawerPanel('devices', '所有设备', devicesPanel),
        drawerPanel('connect', '连接新设备', addSection))
    }

    function PhoneIcon(props) {
      const size = (props && props.size) || 20
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 6, y: 2.5, width: 12, height: 19, rx: 2.6, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('line', { x1: 10.5, y1: 18.3, x2: 13.5, y2: 18.3, stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    return {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        let currentLocale = 'zh'
        try { const loc = ctx.get ? ctx.get('locale') : undefined; const raw = loc && typeof loc.getLocale === 'function' ? String(loc.getLocale()) : ''; if (raw.toLowerCase().startsWith('en')) currentLocale = 'en' } catch { /* zh */ }
        const tr = (key) => (DICT[currentLocale] || DICT.zh)[key] || DICT.zh[key] || key

        function PhoneBody(props) { return h(PhonePanel, Object.assign({}, props, { locale: currentLocale })) }

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: PHONE_ID, kind: PHONE_KIND, priority: 'extension', title: () => tr('tab.title'),
          guide: [{ id: 'main', order: 40, title: () => tr('guide.title'), description: () => tr('guide.description'), icon: PhoneIcon }],
        }), 'phoneRemote: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PHONE_ID }, PhoneBody)), 'phoneRemote: tab body')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PHONE_ID }, function PhoneTitle() { return h('span', null, tr('tab.title')) })), 'phoneRemote: tab title')

        ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          { name: 'conversation.input.left', id: 'phone-remote-launcher', order: 50 },
          function Launcher() {
            return h('button', {
              type: 'button', title: tr('tab.title'), 'aria-label': tr('tab.title'),
              style: { width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.border3}`, borderRadius: 8, background: 'transparent', color: C.text2, cursor: 'pointer', padding: 0 },
              onClick: () => { try { ctx.sidebarRight.openTab(PHONE_KIND) } catch (e) { /* ignore */ } },
            }, h(PhoneIcon, { size: 16 }))
          },
        )), 'phoneRemote: composer launcher')
      },
    }
  },
})
