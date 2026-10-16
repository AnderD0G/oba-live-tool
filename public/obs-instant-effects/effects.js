/* Standalone OBS browser overlay. No polling, media, network, fonts, or random idle events. */
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else factory().start(window);
})(function () {
  'use strict';
  const ENTER_MS = 120;
  const EXIT_MS = 280;
  const DEFAULT_HOLD_MS = 560;
  const PREMIUM_CHANNEL = '🌈 贵宾欢迎';
  const NATIVE_EVENT = 'oba-instant-effect';
  const GROUP_CHANNEL = /^oba\.group\/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[1-9][0-9]{0,8}\/(caption|anim\/[0-2])$/;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const KINDS = ['welcome', 'like', 'follow'];
  const WELCOME_PRESETS = {pearl:960, gold:1200, fireworks:1200, petals:1100, orchid:1100, camellia:1100, hearts:1100, ribbon:1100, starlight:1100, halo:1100};
  const LABELS = {welcome: 'WELCOME', like: 'THANK YOU', follow: 'NEW FOLLOW'};
  const SAMPLES = {welcome: '欢迎 明月 来到直播间', like: '谢谢 明月 的点赞', follow: '谢谢 明月 的关注'};
  const ICONS = {
    welcome: 'M13 68 Q39 20 85 33 M24 70 Q42 41 71 41 M79 17 L82 27 L92 30 L82 33 L79 43 L76 33 L66 30 L76 27 Z',
    like: 'M50 83 C39 74 13 56 13 36 C13 15 39 10 50 31 C61 10 87 15 87 36 C87 56 61 74 50 83 Z',
    follow: 'M50 9 L62 35 L91 39 L70 59 L75 89 L50 74 L25 89 L30 59 L9 39 L38 35 Z',
  };

  function cleanText(value, limit = 64) {
    const text = String(value || '').slice(0, 1024).normalize('NFC')
      .replace(/\s+/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
    return Array.from(text).slice(0, limit).join('');
  }

  function premiumDisplayText(text) {
    const parts = typeof Intl.Segmenter === 'function'
      ? Array.from(new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(text), item => item.segment)
      : Array.from(text);
    const width = part => /^[\x20-\x7e]+$/.test(part) ? part.length * .56 : 1;
    if (parts.reduce((total, part) => total + width(part), 0) <= 14.5) return text;
    let first = '', last = '', used = 0;
    for (const part of parts) {
      if (used + width(part) > 8.5) break;
      first += part; used += width(part);
    }
    used = 0;
    for (const part of parts.slice().reverse()) {
      if (used + width(part) > 4.5) break;
      last = part + last; used += width(part);
    }
    return first + '…' + last;
  }

  function readOptions(search, pageKind) {
    const params = new URLSearchParams(search || '');
    const requestedKind = params.get('kind');
    const channel = params.get('channel');
    const native = params.get('transport') === 'native' && params.getAll('transport').length === 1 &&
      params.getAll('channel').length === 1 && KINDS.includes(pageKind) &&
      typeof channel === 'string' && channel.trim().length > 0 && channel.length <= 200 &&
      !/[\u0000-\u001f\u007f]/.test(channel);
    const kind = native ? pageKind : KINDS.includes(requestedKind) ? requestedKind : KINDS.includes(pageKind) ? pageKind : 'welcome';
    const requestedHold = params.has('hold') && params.get('hold').trim() ? Number(params.get('hold')) : DEFAULT_HOLD_MS;
    const holdMs = Number.isFinite(requestedHold) ? Math.min(600, Math.max(400, requestedHold)) : DEFAULT_HOLD_MS;
    const requestedStyle = params.get('style');
    const presetId = params.get('preset');
    const validPreset = kind === 'welcome' && Object.hasOwn(WELCOME_PRESETS, presetId);
    return {
      kind,
      mode: params.get('mode') === 'focus' ? 'focus' : 'wide',
      style: ['gold', 'rainbow', 'arc'].includes(requestedStyle) ? requestedStyle : 'pearl',
      text: params.has('preset') && !validPreset ? '' : cleanText(params.get('text')),
      ...(validPreset ? {presetId} : {}),
      holdMs,
      demo: params.get('demo') === '1',
      transport: native ? 'native' : 'url',
      channel: native ? channel : '',
    };
  }

  function readNativeEvent(value, options) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = ['channel', 'kind', 'operation', 'token', 'text', 'mode', 'style', 'holdMs', 'presetId', 'welcomeLane', 'group', 'role', 'slot', 'placement', 'actionKind'];
    if (Object.keys(value).some(key => !keys.includes(key)) || value.channel !== options.channel || value.kind !== options.kind ||
        !['show', 'clear'].includes(value.operation) || typeof value.token !== 'string' || !value.token.trim() ||
        value.token.length > 200 || /[\u0000-\u001f\u007f]/.test(value.token)) return null;
    const groupChannel = options.transport === 'native' && options.kind === 'welcome' && GROUP_CHANNEL.exec(options.channel);
    if (groupChannel || value.group !== undefined || value.role !== undefined) {
      const role = groupChannel && groupChannel[1] === 'caption' ? 'caption' : 'animation';
      if (!groupChannel || value.group !== true || value.role !== role || value.welcomeLane !== undefined || (value.actionKind !== undefined && !['enter','follow','like','gift'].includes(value.actionKind))) return null;
      if (value.operation === 'clear') return {operation:'clear', token:value.token};
      if (typeof value.text !== 'string' || (role === 'caption' && !cleanText(value.text)) || !['wide','focus'].includes(value.mode) ||
          !['brief','rainbow'].includes(value.style) || !Number.isInteger(value.holdMs) || value.holdMs < 1000 || value.holdMs > 10000 ||
          !['main-stage','corner-left','corner-right'].includes(value.slot) ||
          !['border','lower-edge','lower-center','center','corner-left','corner-right','full-screen'].includes(value.placement) ||
          (role === 'animation' && !Object.hasOwn(WELCOME_PRESETS,value.presetId)) || (role === 'caption' && value.presetId !== undefined)) return null;
      return {operation:'show', token:value.token, text:cleanText(value.text,140), mode:value.mode, style:value.style,
        holdMs:value.holdMs,group:true,role,slot:value.slot,placement:value.placement,actionKind:value.actionKind??'enter',...(value.presetId?{presetId:value.presetId}:{})};
    }
    if (value.slot !== undefined || value.placement !== undefined || value.actionKind !== undefined) return null;
    const premiumSource = options.transport === 'native' && options.kind === 'welcome' && options.channel === PREMIUM_CHANNEL;
    const premium = premiumSource && value.welcomeLane === 'premium';
    if ((value.welcomeLane !== undefined && !premium) || (premiumSource && !premium)) return null;
    if ((value.presetId !== undefined && (value.kind !== 'welcome' || typeof value.presetId !== 'string' || !Object.hasOwn(WELCOME_PRESETS, value.presetId))) ||
        (value.text !== undefined && typeof value.text !== 'string') ||
        (value.mode !== undefined && !['wide', 'focus'].includes(value.mode)) ||
        (value.style !== undefined && !['arc', 'gold', 'rainbow'].includes(value.style)) ||
        (value.holdMs !== undefined && (!Number.isInteger(value.holdMs) || value.holdMs < 500 || value.holdMs > 10_000))) return null;
    if (value.operation === 'clear') return {operation: 'clear', token: value.token};
    if (typeof value.text !== 'string' || !['wide', 'focus'].includes(value.mode) ||
        !['arc', 'gold', 'rainbow'].includes(value.style) || !Number.isInteger(value.holdMs) ||
        value.holdMs < 500 || value.holdMs > 10_000) return null;
    const text = cleanText(value.text, premium ? 140 : 64);
    if (!text) return null;
    return {operation: 'show', token: value.token, text, mode: value.mode, style: value.style,
      holdMs: premium ? Math.min(3600, value.holdMs) : Math.min(600, value.holdMs),
      ...(premium ? {welcomeLane:'premium'} : {}), ...(value.presetId ? {presetId:value.presetId} : {})};
  }

  function createRenderer(environment, options) {
    const document = environment.document;
    const stage = document.getElementById('stage');
    const reduced = Boolean(environment.matchMedia && environment.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let timer = null;
    let active = null;
    let activeToken = null;

    function element(tag, className, parent, text) {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      if (parent) parent.appendChild(node);
      return node;
    }

    function svgNode(tag, attributes, parent) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      if (parent) parent.appendChild(node);
      return node;
    }

    function icon(parent, kind, className) {
      const svg = svgNode('svg', {viewBox: '0 0 100 100', 'aria-hidden': 'true'}, parent);
      svg.setAttribute('class', className);
      svgNode('path', {
        d: ICONS[kind], fill: kind === 'welcome' ? 'none' : 'currentColor',
        stroke: 'currentColor', 'stroke-width': kind === 'welcome' ? 3 : 1.5,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, svg);
      return svg;
    }

    function flowers(parent) {
      const svg = svgNode('svg', {viewBox: '0 0 300 130', 'aria-hidden': 'true'}, parent);
      svg.setAttribute('class', 'instant-flower-arc');
      svgNode('path', {d: 'M16 104 Q70 12 264 61', fill: 'none', stroke: 'currentColor', 'stroke-width': .8, opacity: .45}, svg);
      const definitions = svgNode('defs', {}, svg);
      const flower = svgNode('g', {id: 'instant-flower'}, definitions);
      for (let angle = 0; angle < 360; angle += 60) {
        svgNode('ellipse', {cx: 0, cy: -5.6, rx: 2.9, ry: 5.5, transform: `rotate(${angle})`, fill: 'currentColor', opacity: .78}, flower);
      }
      svgNode('circle', {r: 2.1, fill: '#fff6ce'}, flower);
      const positions = [[25, 85, .64, -8], [67, 47, 1, 12], [121, 32, .8, -7], [184, 35, 1.2, 14], [244, 53, .7, -5]];
      for (const [x, y, scale, angle] of positions) {
        svgNode('use', {href: '#instant-flower', transform: `translate(${x} ${y}) scale(${scale}) rotate(${angle})`}, svg);
      }
      svgNode('path', {d: 'M84 35 Q90 22 106 25 Q99 39 84 35 M209 39 Q218 27 233 33 Q222 44 209 39', fill: 'currentColor', opacity: .3}, svg);
    }

    function welcomeDecoration(parent, presetId) {
      if (['orchid', 'camellia'].includes(presetId)) {flowers(parent); return;}
      const svg = svgNode('svg', {viewBox:'0 0 300 130', 'aria-hidden':'true', class:'instant-welcome-decoration'}, parent);
      const spots = [[30,82],[74,38],[139,20],[219,37],[269,77]];
      if (presetId === 'gold') for (const [x,y] of spots) {
        svgNode('circle', {cx:x,cy:y,r:5,fill:'#f4d273',stroke:'#fff6cd','stroke-width':1,opacity:.8}, svg);
        svgNode('path', {d:`M${x-1} ${y-3}v6m2-6v6`,stroke:'#a97928','stroke-width':.8,fill:'none'}, svg);
      }
      else if (presetId === 'fireworks') for (const [x,y] of [spots[0],spots[2],spots[4]]) for(let ray=0;ray<12;ray++) {
        const angle=Math.PI*2*ray/12;
        svgNode('line',{x1:x+Math.cos(angle)*5,y1:y+Math.sin(angle)*5,x2:x+Math.cos(angle)*13,y2:y+Math.sin(angle)*13,stroke:'currentColor','stroke-width':1,opacity:.65},svg);
      }
      else if (presetId === 'petals') for (const [index,[x,y]] of spots.entries()) svgNode('ellipse',{cx:x,cy:y,rx:3,ry:7,transform:`rotate(${index*29} ${x} ${y})`,fill:'currentColor',opacity:.6},svg);
      else if (presetId === 'hearts') for (const [x,y] of [spots[0],spots[2],spots[4]]) svgNode('path',{d:'M0 8C-10 1-8-8 0-3C8-8 10 1 0 8Z',transform:`translate(${x} ${y})`,fill:'currentColor',opacity:.6},svg);
      else if (presetId === 'ribbon') for(let index=0;index<3;index++) svgNode('path',{d:`M${18+index*8} ${98-index*9}Q100 ${-12+index*14} ${276-index*5} ${70+index*9}`,stroke:'currentColor','stroke-width':index===1?2:.7,fill:'none',opacity:.4},svg);
      else if (presetId === 'starlight') for(const [x,y] of spots) svgNode('path',{d:'M0-6L1.8-1.8L6 0L1.8 1.8L0 6L-1.8 1.8L-6 0L-1.8-1.8Z',transform:`translate(${x} ${y})`,fill:'currentColor',opacity:.65},svg);
      else if (presetId === 'halo') {
        svgNode('ellipse',{cx:150,cy:72,rx:131,ry:50,stroke:'currentColor','stroke-width':.7,fill:'none',opacity:.3},svg);
        for(const [x,y] of spots) svgNode('circle',{cx:x,cy:y,r:3,fill:'currentColor',opacity:.6},svg);
      }
    }

    function premiumArtwork(card, text, groupAction) {
      card.dataset.originalText = text;
      card.setAttribute('aria-label', text);
      const arch = svgNode('svg', {viewBox:'0 0 1000 290', class:'instant-premium-arch', 'aria-hidden':'true'}, card);
      const definitions = svgNode('defs', {}, arch);
      const gradient = svgNode('linearGradient', {id:'premium-welcome-rainbow', x1:'0%', y1:'0%', x2:'100%', y2:'0%'}, definitions);
      for (const [offset, color] of [['0%','#ff6eaf'],['17%','#ff9b58'],['33%','#fff07c'],['50%','#9cffe1'],['67%','#8fe6ff'],['83%','#bfa0ff'],['100%','#ff8cde']])
        svgNode('stop', {offset, 'stop-color':color}, gradient);
      svgNode('path', {id:'premium-welcome-curve', d:'M100 240 Q500 -5 900 240'}, definitions);
      const title = svgNode('text', {fill:'url(#premium-welcome-rainbow)', 'text-anchor':'middle', class:'instant-premium-title'}, arch);
      const curveText = svgNode('textPath', {href:'#premium-welcome-curve', startOffset:'50%'}, title);
      curveText.textContent = groupAction && groupAction !== 'enter' ? 'THANK YOU' : 'WELCOME';
      const chinese = svgNode('text', {x:500, y:278, fill:'url(#premium-welcome-rainbow)', 'text-anchor':'middle', class:'instant-premium-chinese'}, arch);
      if (groupAction) {
        chinese.setAttribute('class','instant-premium-subtitle');
        chinese.textContent = {enter:'SO GLAD YOU’RE HERE',follow:'FOR FOLLOWING',like:'FOR THE LOVE',gift:'FOR YOUR SUPPORT'}[groupAction];
      } else chinese.textContent = '欢迎';
      element('span', 'instant-premium-edge instant-premium-edge-left', card);
      element('span', 'instant-premium-edge instant-premium-edge-right', card);
      element('div', 'instant-premium-name', card, premiumDisplayText(text));
    }

    function clear(expectedToken) {
      if (expectedToken !== undefined && (!active || expectedToken !== activeToken)) return false;
      if (timer !== null) environment.clearTimeout(timer);
      timer = null;
      active = null;
      activeToken = null;
      stage.replaceChildren();
      return true;
    }

    function show(value, requestedKind, presentation) {
      const kind = KINDS.includes(requestedKind) ? requestedKind : options.kind;
      const visual = presentation || options;
      const group = kind === 'welcome' && options.transport === 'native' && GROUP_CHANNEL.test(options.channel) && visual.group === true;
      const premium = kind === 'welcome' && ((group && visual.role === 'caption' && visual.style === 'rainbow') || (options.transport === 'native' && options.channel === PREMIUM_CHANNEL && visual.welcomeLane === 'premium'));
      const text = cleanText(value, premium ? 140 : 64);
      if (!text && !(group && visual.role === 'animation')) return false;
      const presetId = visual.presetId;
      if (presetId !== undefined && (kind !== 'welcome' || !Object.hasOwn(WELCOME_PRESETS, presetId))) return false;
      clear();
      const card = element('section', 'instant-card', stage);
      active = card;
      activeToken = presentation ? presentation.token : null;
      card.dataset.kind = kind;
      card.dataset.mode = visual.mode;
      card.dataset.style = visual.style;
      card.dataset.reduced = String(reduced);
      if (premium) card.dataset.welcomeLane = 'premium';
      if (group) {card.dataset.groupRole = visual.role; card.dataset.groupSlot = visual.slot; card.dataset.groupPlacement = visual.placement;}
      if (presetId) card.dataset.preset = presetId;
      card.setAttribute('role', 'status');
      const holdMs = group ? visual.holdMs - ENTER_MS - EXIT_MS : premium ? visual.holdMs : presetId ? WELCOME_PRESETS[presetId] - ENTER_MS - EXIT_MS : visual.holdMs;
      card.style.setProperty('--life', `${ENTER_MS + holdMs + EXIT_MS}ms`);
      const length = Array.from(text).length;
      card.style.setProperty('--copy-size', length > 32 ? '4.1cqw' : length > 22 ? '4.9cqw' : '6.3cqw');

      if (premium) premiumArtwork(card, text, group ? visual.actionKind : undefined);
      else {
      const ornament = element('div', 'instant-ornament', card);
      if (presetId && presetId !== 'pearl') welcomeDecoration(ornament, presetId);
      else if (visual.mode === 'focus') flowers(ornament);
      else {
        element('span', 'instant-orbit', ornament);
        element('span', 'instant-sweep', ornament);
      }
      const content = element('div', 'instant-content', card);
      const badge = element('div', 'instant-badge', content);
      icon(badge, kind, 'instant-icon');
      const copy = element('div', 'instant-copy', content);
      element('span', 'instant-label', copy, group ? {enter:'WELCOME',follow:'THANK YOU',like:'THANK YOU',gift:'THANK YOU'}[visual.actionKind] : LABELS[kind]);
      element('div', 'instant-message', copy, text);
      element('span', 'instant-flourish', copy);

      if (visual.mode === 'wide' && !reduced && (!presetId || presetId === 'pearl')) {
        const particles = element('div', 'instant-particles', card);
        for (let index = 0; index < 12; index++) {
          const particle = element('span', 'instant-particle', particles);
          const angle = Math.PI * 2 * index / 12;
          particle.style.setProperty('--x', `${Math.round(Math.cos(angle) * 42)}cqw`);
          particle.style.setProperty('--y', `${Math.round(Math.sin(angle) * 13)}cqw`);
          particle.style.setProperty('--turn', `${index * 23 - 80}deg`);
          particle.style.setProperty('--delay', `${(index % 4) * 18}ms`);
          particle.style.setProperty('--size', `${index % 3 === 0 ? 1.6 : 1}cqw`);
          if (kind !== 'welcome') icon(particle, kind, 'instant-particle-icon');
        }
      }
      }
      if (group && visual.role === 'animation') {
        card.dataset.style = 'rainbow';
        // The personalized caption is a separate receiver in the same group.
        const content = card.children && Array.from(card.children).find(child => child.className === 'instant-content');
        if (content) content.hidden = true;
      }

      timer = environment.setTimeout(function () {
        timer = null;
        if (active !== card) return;
        card.classList.add('is-leaving');
        timer = environment.setTimeout(clear, EXIT_MS);
      }, ENTER_MS + holdMs);
      return true;
    }
    return {show, clear};
  }

  function start(environment) {
    const document = environment.document;
    const options = readOptions(environment.location.search, document.body.dataset.kind);
    const renderer = createRenderer(environment, options);
    let nativeListener = null;
    if (options.transport === 'native' && environment.addEventListener && environment.removeEventListener) {
      nativeListener = function (event) {
        const value = readNativeEvent(event && event.detail, options);
        if (!value) return;
        if (value.operation === 'clear') renderer.clear(value.token);
        else renderer.show(value.text, options.kind, value);
      };
      environment.addEventListener(NATIVE_EVENT, nativeListener);
    }
    if (options.demo) {
      document.body.dataset.demo = 'true';
      const controls = document.createElement('nav');
      controls.className = 'instant-demo-controls';
      controls.setAttribute('aria-label', '互动特效预览');
      for (const kind of KINDS) {
        const button = document.createElement('button');
        button.textContent = {welcome: '欢迎 · 重播', like: '点赞 · 重播', follow: '关注 · 重播'}[kind];
        button.addEventListener('click', function () {renderer.show(options.text || SAMPLES[kind], kind);});
        controls.appendChild(button);
      }
      document.body.appendChild(controls);
    }
    if (options.text || options.demo) renderer.show(options.text || SAMPLES[options.kind]);
    if (environment.addEventListener) environment.addEventListener('pagehide', function () {
      if (nativeListener) environment.removeEventListener(NATIVE_EVENT, nativeListener);
      nativeListener = null;
      renderer.clear();
    }, {once: true});
    return renderer;
  }
  return {readOptions, readNativeEvent, createRenderer, start};
});
