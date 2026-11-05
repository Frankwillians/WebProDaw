/**
 * Espique: o áudio que chega por WebRTC renderiza dentro do WebAudio?
 *
 * É isto que o cabo virtual da DAW precisa: a track remota entra num
 * `MediaStreamAudioSourceNode` e de lá no barramento. Se o Chromium entregar
 * silêncio nesse caminho, a DAW mostra a faixa remota viva e ninguém ouve nada
 * — que é o que a perna `sala-cable` do `npm run app:test` viu ("volta 0%").
 *
 *   node --check spike-rtc-audio.cjs
 *   ./node_modules/electron/dist/electron.exe spike-rtc-audio.cjs
 *
 * O endereço do servidor da sala vem do ambiente, não da linha de comando: o
 * Electron trata um segundo argumento como caminho de app e sai com 127.
 *
 *   SALA_URL=http://127.0.0.1:5263 ... (padrão)   SALA_LIMITE=150000
 *
 * Duas testemunhas para não trocar falha de rede por falha de render: os bytes
 * que chegaram do outro lado (`inbound-rtp`) e um oscilador local passando pelo
 * MESMO analizador. Oscilador marca e remoto não = render. Nenhum marca = o
 * contexto. Bytes não crescem = a mídia nunca veio. E o amostrador espera um
 * quantum de áudio entre leituras: laço síncrono lê o mesmo bloco e devolve zero
 * até para um oscilador vivo.
 *
 * O resultado vai sendo escrito em `window.__S` e o Node lê por sondagem: uma
 * etapa que trave ainda deixa ver onde parou, em vez de engolir a corrida.
 */

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const SALA = (process.env.SALA_URL || 'http://127.0.0.1:5263').replace(/\/+$/, '')
const LIMITE_MS = Number(process.env.SALA_LIMITE || 150000)

const PROBE = `(() => {
  const S = { etapas: [], ok: false, feito: false };
  window.__S = S;
  const marca = (nome, valor) => { S.etapas.push({ nome, valor, t: Math.round(performance.now()) }); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const prazo = (p, ms, nome) =>
    Promise.race([p, sleep(ms).then(() => { throw new Error('timeout em ' + nome); })]);

  const novoRoom = async (nome, sala) => {
    const { Room } = await import('/js/rtc.js');
    const r = new Room();
    r.ice = { stun: '', turn: '', turnUser: '', turnPass: '', hostOnly: true };
    r.jamMode = true;
    await prazo(r.connect(sala, nome), 20000, 'connect ' + nome);
    return r;
  };

  // A medição tem que atravessar quanta de áudio reais: um laço síncrono lê o
  // mesmo bloco e devolve zero até para um oscilador vivo. Cada amostra espera.
  const medir = async (ctx, src) => {
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0;
    src.connect(an);
    const buf = new Float32Array(1024);
    let pico = 0;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 16));
      an.getFloatTimeDomainData(buf);
      for (const v of buf) pico = Math.max(pico, Math.abs(v));
    }
    src.disconnect(an);
    return +pico.toFixed(4);
  };

  const fluxoDeAudio = async (r) => {
    let recebido = 0;
    let enviado = 0;
    for (const c of r.conns.values()) {
      const st = await c.pc.getStats();
      st.forEach((x) => {
        if (x.kind !== 'audio') return;
        if (x.type === 'inbound-rtp') recebido += x.bytesReceived || 0;
        if (x.type === 'outbound-rtp') enviado += x.bytesSent || 0;
      });
    }
    return { recebido, enviado };
  };

  (async () => {
    let A, B, C, D, osc, oscCtrl, oscD, el, el2, el3;
    try {
      const sala = 'spike' + Math.random().toString(36).slice(2, 6);
      S.sala = sala;

      const ctxA = new AudioContext();
      await ctxA.resume().catch(() => {});
      A = await novoRoom('A', sala);
      marca('A na sala', 'ctxA=' + ctxA.state);

      osc = ctxA.createOscillator();
      osc.frequency.value = 250;
      const gain = ctxA.createGain();
      gain.gain.value = 0.3;
      const destA = ctxA.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(destA);
      osc.start();
      A.setAudioTrack(destA.stream.getAudioTracks()[0]);

      const ctxB = new AudioContext();
      await ctxB.resume().catch(() => {});

      // TESTEMUNHA 1: oscilador local pelo mesmo caminho de medição
      oscCtrl = ctxB.createOscillator();
      oscCtrl.frequency.value = 200;
      const gainCtrl = ctxB.createGain();
      gainCtrl.gain.value = 0.25;
      oscCtrl.connect(gainCtrl);
      oscCtrl.start();
      await sleep(600);
      S.ctrl = { estadoCtx: ctxB.state, picoOsc: await medir(ctxB, gainCtrl) };
      marca('testemunha local', JSON.stringify(S.ctrl));

      const vistos = [];
      const esperaTrack = (r) =>
        new Promise((resolve) => {
          const olho = (e) => {
            vistos.push(e.detail.kind + '/' + e.detail.track.kind);
            if (e.detail.kind === 'av' && e.detail.track.kind === 'audio') {
              r.removeEventListener('remote-track', olho);
              resolve(e.detail.track);
            }
          };
          r.addEventListener('remote-track', olho);
          setTimeout(() => resolve(null), 20000);
        });

      // B escuta a chegada antes de conectar: a track pode vir no handshake
      B = await import('/js/rtc.js').then((m) => {
        const r = new m.Room();
        r.ice = { stun: '', turn: '', turnUser: '', turnPass: '', hostOnly: true };
        r.jamMode = true;
        return r;
      });
      const promesa = esperaTrack(B);
      await prazo(B.connect(sala, 'B'), 20000, 'connect B');
      const track = await promesa;
      const fluxoA = await fluxoDeAudio(A);
      const fluxoB = await fluxoDeAudio(B);
      if (!track) {
        S.semTrack = {
          vistos,
          paresB: [...B.peers.values()].map((p) => p.name),
          A: fluxoA,
          B: fluxoB,
          receptoresB: [...B.conns.values()].flatMap((c) =>
            c.pc.getReceivers().map((rc) => rc.track.kind + ':' + rc.track.readyState + ':' + c.pc.connectionState)),
          estadoB: [...B.conns.values()].map((c) => c.pc.connectionState + '/' + c.kind),
        };
        marca('sem track', JSON.stringify(S.semTrack));
        return;
      }
      track.enabled = true;
      S.track = { estado: track.readyState, mudo: track.muted, rotulo: track.label };
      marca('track chegou', JSON.stringify(S.track));

      // TESTEMUNHA 2: os bytes da rede estão crescendo dos dois lados?
      const b1 = await fluxoDeAudio(B);
      const a1 = await fluxoDeAudio(A);
      await sleep(1500);
      const b2 = await fluxoDeAudio(B);
      const a2 = await fluxoDeAudio(A);
      S.rede = {
        Brecebido: [b1.recebido, b2.recebido],
        Benviado: [b1.enviado, b2.enviado],
        Aenviado: [a1.enviado, a2.enviado],
        cresceuEmB: b2.recebido > b1.recebido,
        AestaMandando: a2.enviado > a1.enviado,
      };
      marca('bytes rtp', JSON.stringify(S.rede));

      const soWebAudio = ctxB.createMediaStreamSource(new MediaStream([track]));
      S.medidas = {};

      // 1) só WebAudio — o caminho que a DAW usa hoje
      await sleep(2500);
      S.medidas['so WebAudio'] = await medir(ctxB, soWebAudio);
      marca('medida 1', String(S.medidas['so WebAudio']));

      // 2) + <audio> mudo na MESMA stream (o "wake" do Chromium)
      el = document.createElement('audio');
      el.autoplay = true;
      el.muted = true;
      el.srcObject = new MediaStream([track]);
      document.body.appendChild(el);
      S.el1 = 'antes do play';
      await el.play().then(() => { S.el1 = el.paused ? 'pausado' : 'tocando'; })
        .catch((e) => { S.el1 = 'negado: ' + e.name; });
      await sleep(2500);
      S.medidas['com audio mudo'] = await medir(ctxB, soWebAudio);
      marca('medida 2', String(S.medidas['com audio mudo']) + ' el1=' + S.el1);

      // 3) stream separada para o elemento, volume 0
      el2 = document.createElement('audio');
      el2.autoplay = true;
      el2.volume = 0;
      el2.srcObject = new MediaStream([track]);
      document.body.appendChild(el2);
      await el2.play().catch(() => {});
      await sleep(2500);
      S.medidas['com audio volume 0'] = await medir(ctxB, soWebAudio);
      S.el2 = el2.paused ? 'pausado' : 'tocando';
      marca('medida 3', String(S.medidas['com audio volume 0']) + ' el2=' + S.el2);

      // 4) uma única stream dividida entre o elemento e o WebAudio
      const compartilhada = new MediaStream([track]);
      el3 = document.createElement('audio');
      el3.autoplay = true;
      el3.muted = true;
      el3.srcObject = compartilhada;
      document.body.appendChild(el3);
      await el3.play().catch(() => {});
      const src3 = ctxB.createMediaStreamSource(compartilhada);
      await sleep(2500);
      S.medidas['stream unica com audio'] = await medir(ctxB, src3);
      marca('medida 4', String(S.medidas['stream unica com audio']));

      // 5) pelo SDK, que é o que a DAW de fato usa
      try {
        const { joinRoom } = await import('/js/sala-sdk.js');
        C = await prazo(joinRoom({ url: SALA_END, room: sala + 'c', name: 'C', audioContext: ctxB, mode: 'jam', ice: { hostOnly: true } }), 25000, 'join C');
        D = await prazo(joinRoom({ url: SALA_END, room: sala + 'c', name: 'D', audioContext: ctxA, mode: 'jam', ice: { hostOnly: true } }), 25000, 'join D');
        oscD = ctxA.createOscillator();
        oscD.frequency.value = 320;
        const gainD = ctxA.createGain();
        gainD.gain.value = 0.3;
        oscD.connect(gainD);
        oscD.start();
        D.useNode(gainD, { kind: 'daw' });
        await sleep(6000);
        const canal = [...C.channels.values()][0];
        S.sdk = { canais: C.channels.size, tem: !!canal };
        if (canal) {
          const srcDest = ctxB.createMediaStreamSource(canal.stream);
          S.sdk['na stream'] = await medir(ctxB, srcDest);
          srcDest.disconnect();
          S.sdk['level()'] = +canal.level().peak.toFixed(3);
          canal.setMonitor(true);
          await sleep(2500);
          S.sdk['com monitor level()'] = +canal.level().peak.toFixed(3);
          const src2 = ctxB.createMediaStreamSource(canal.stream);
          S.sdk['com monitor na stream'] = await medir(ctxB, src2);
          src2.disconnect();
          S.sdk['monitor é'] = canal.monitorEl ? canal.monitorEl.tagName : null;
        }
        marca('sdk', JSON.stringify(S.sdk));
      } catch (e) {
        S.sdk = { erro: String((e && e.message) || e) };
        marca('sdk erro', S.sdk.erro);
      }

      S.resumo = {
        ctrl: S.ctrl.picoOsc,
        rede: S.rede,
        medidas: S.medidas,
        sdk: S.sdk,
        el1: S.el1,
        el2: S.el2,
      };
      S.ok = true;
    } catch (e) {
      S.erro = String((e && e.message) || e);
      S.pilha = String((e && e.stack) || '').slice(0, 500);
      marca('erro', S.erro);
    } finally {
      try { if (C) C.leave(); if (D) D.leave(); } catch {}
      try { if (A) A.leave(); if (B) B.leave(); } catch {}
      for (const n of [osc, oscCtrl, oscD]) { try { if (n) n.stop(); } catch {} }
      for (const n of [el, el2, el3]) { try { if (n) n.remove(); } catch {} }
      S.feito = true;
    }
  })();
  return 'rodando';
})()`

async function main() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  const avisos = []
  win.webContents.on('console-message', (_e, _lvl, message) => {
    if (/error|denied|Failed|not allowed/i.test(message)) {
      avisos.push(message.slice(0, 200))
      if (avisos.length <= 12) console.log('[página]', message.slice(0, 200))
    }
  })
  await win.loadURL(`${SALA}/?debug=1`)
  await win.webContents.executeJavaScript(`var SALA_END = ${JSON.stringify(SALA)}; true`)
  await win.webContents.executeJavaScript(PROBE)

  const inicio = Date.now()
  let ultimo = ''
  let bruto = '{}'
  while (Date.now() - inicio < LIMITE_MS) {
    await new Promise((r) => setTimeout(r, 1500))
    try {
      bruto = (await win.webContents.executeJavaScript('window.__S ? JSON.stringify(window.__S) : "{}"')) || '{}'
      const lido = JSON.parse(bruto)
      const traco = (lido.etapas || []).map((e) => `${e.nome}=${e.valor}`).join(' | ')
      if (traco !== ultimo) {
        ultimo = traco
        console.log(`  [${((Date.now() - inicio) / 1000).toFixed(0)}s] ${traco}`)
      }
      if (lido.feito) break
    } catch (e) {
      console.log('  sondagem falhou: ' + String(e.message).slice(0, 80))
    }
  }
  let estado
  try {
    estado = JSON.parse(bruto)
  } catch {
    estado = { erro: 'estado ilegível', bruto: String(bruto).slice(0, 300) }
  }
  const saida = {
    sala: SALA,
    estourouPrazo: estado.feito !== true,
    avisosDaPagina: avisos.slice(0, 12),
    estado,
  }
  fs.writeFileSync(path.join(__dirname, 'spike-rtc-audio.out.json'), JSON.stringify(saida, null, 2))
  console.log('SPIKE ' + JSON.stringify(estado.resumo || estado, null, 2))
  console.log(saida.estourouPrazo ? 'RESULTADO: estourou o prazo' : 'RESULTADO: concluiu')
  app.exit(0)
}

app.whenReady().then(main)
