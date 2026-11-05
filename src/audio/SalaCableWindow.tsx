/**
 * Cabo virtual — a janela que liga a master da DAW a uma sala SALA.
 *
 * Mentalidade de mesa: o que a sala ouve é um envio saído do fader mestre, e o
 * que a sala devolve entra pelos alto-falantes depois desse ponto de envio
 * (mix-minus). Um console físico faz isso com um segundo barramento; aqui são
 * dois nós a mais no `AudioEngine` (`ensureCallCable` e `callReturn`).
 *
 * A mesma janela existe no navegador e no executável: ela só fala com o
 * `sala-sdk.js`, carregado por `import()` da origem informada, e com os nós do
 * engine. O que muda entre os dois é o transporte (CSP e certificado), tratado
 * em `desktop/server.cjs` e `desktop/main.cjs`, não aqui.
 */

import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from './audio-engine'

/** A peça do SDK é JS puro, sem tipos publicados: o contrato é estreito e nomeado aqui. */
interface SalaChannel {
  id: string
  peerId: string
  kind: string
  name: string
  stream: MediaStream
  setGainDb: (db: number) => SalaChannel
  setPan: (v: number) => SalaChannel
  setDelayMs: (ms: number) => SalaChannel
  mute: (on: boolean) => SalaChannel
  level: () => { db: number; peak: number; lin: number }
}

interface SalaLink {
  peerId: string | null
  state: { connected: boolean; isPrivate?: boolean; room?: string; instance?: string | null; hosted?: boolean }
  opts: { room: string; name: string; pass?: string }
  channels: Map<string, SalaChannel>
  useNode: (node: AudioNode, meta?: { kind?: 'daw' | 'mic'; trimDb?: number }) => GainNode
  useMicrophone: (opts?: { deviceId?: string; trimDb?: number }) => Promise<unknown>
  removeSource: (kind?: string, reapply?: boolean) => void
  setTrim: (kind: string, db: number) => boolean
  muteSend: (on: boolean) => boolean
  setLimiter: (on: boolean) => boolean
  sendLevel: () => { db: number; peak: number; lin: number }
  setRoomName: (name: string) => void
  inviteLink: () => string
  peerList: () => { id: string; name: string; mic: boolean; cam: boolean; screen: boolean; channels: string[] }[]
  autoCompensate: () => { id: string; ms: number }[]
  stats: () => Promise<{ peerId: string; name: string; connection: string; rttMs: number | null; kbpsIn: number }[]>
  on: (type: string, fn: (event: CustomEvent) => void) => () => void
  leave: () => void
}

export interface SalaCableProps {
  engine: AudioEngine | null
  onClose: () => void
  /**
   * Escondida, não desmontada: fechar a janela no meio de uma jam não pode derrubar
   * a chamada, então o app continua montando este componente e só tira a tela dele.
   */
  hidden?: boolean
  /** Diz ao app se o cabo está no ar, para a luz do jack no master dizer a verdade. */
  onLiveChange?: (live: boolean) => void
  /**
   * Cria a faixa gravável de um participante e devolve o id dela.
   * A `key` é o id do canal na sala: a faixa o guarda para que o botão IN dela
   * mexa no retorno certo, e para que o undo nunca a reliue sozinha.
   */
  createLane: (label: string, key: string) => string
  removeLane: (trackId: string) => void
  notify: (text: string) => void
}

const STORE_KEY = 'sala.cable'

function readStored(): { server: string; room: string; name: string; lanes: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    return {
      server: String(raw.server || ''),
      room: String(raw.room || ''),
      name: String(raw.name || ''),
      lanes: raw.lanes !== false,
    }
  } catch {
    return { server: '', room: '', name: '', lanes: true }
  }
}

const toDbText = (v: number) => (v <= -59 ? '-inf' : v.toFixed(1))

export function SalaCableWindow({
  engine,
  hidden = false,
  onLiveChange,
  onClose,
  createLane,
  removeLane,
  notify,
}: SalaCableProps) {
  const stored = useRef(readStored())
  const [server, setServer] = useState(stored.current.server || 'https://localhost:5250')
  const [room, setRoom] = useState(stored.current.room || 'geral')
  const [pass, setPass] = useState('')
  const [name, setName] = useState(stored.current.name || 'Minha DAW')
  const [lanes, setLanes] = useState(stored.current.lanes)
  const [micAlong, setMicAlong] = useState(false)
  const [hostOnly, setHostOnly] = useState(true)

  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [trimDb, setTrimDb] = useState(0)
  const [sendMuted, setSendMuted] = useState(false)
  const [limiter, setLimiter] = useState(false)
  const [sendPeak, setSendPeak] = useState(0)
  const [returnPeak, setReturnPeak] = useState(0)
  const [peers, setPeers] = useState<{ id: string; name: string; channels: string[] }[]>([])
  const [invite, setInvite] = useState('')
  const [privateRoom, setPrivateRoom] = useState(false)

  const linkRef = useRef<SalaLink | null>(null)
  /** canal -> faixa criada por ele, para soltar exatamente o que se patcheou. */
  const laneOfChannel = useRef<Map<string, string>>(new Map())
  /**
   * O `lanes` vivo, lido por quem foi patcheado depois.
   *
   * Os ouvintes do SDK são registrados uma vez, no connect, e guardam a função
   * daquela renderização: se a flag fosse lida direto do closure, desligar "faixa
   * gravável" no meio da jam não faria efeito nos canais que chegassem em
   * seguida. Um ref é a única coisa que um listener de longa vida pode ler.
   */
  const lanesRef = useRef(lanes)
  lanesRef.current = lanes

  const refreshPeers = () => {
    const link = linkRef.current
    if (!link) return
    setPeers(link.peerList().map((p) => ({ id: p.id, name: p.name, channels: p.channels })))
  }

  /** Um participante remoto vira faixa gravável + retorno monitorado fora do envio. */
  const patchChannel = (ch: SalaChannel) => {
    if (!engine) return
    const label = ch.kind === 'screen' ? `${ch.name} · tela` : ch.name
    if (!lanesRef.current) {
      // sem faixa: só o retorno, pelos alto-falantes, sem voltar pelo cabo
      engine.connectCallReturn(ch.id, ch.stream)
      return
    }
    try {
      const trackId = createLane(label, ch.id)
      // monitor = false de propósito: a escuta desse canal sai pelo callReturn,
      // que está depois do ponto de envio. Monitorar pela própria mixagem faria o
      // outro músico ouvir a si mesmo atrasado — o eco que mata qualquer jam.
      engine.connectCallInput(trackId, ch.stream, false, label)
      engine.connectCallReturn(ch.id, ch.stream, true)
      laneOfChannel.current.set(ch.id, trackId)
      notify(`"${label}" virou faixa gravável`)
    } catch (err) {
      setError((err as Error).message || 'não deu para patchear o canal')
      engine.connectCallReturn(ch.id, ch.stream)
    }
  }

  const unpatchChannel = (ch: SalaChannel) => {
    if (!engine) return
    engine.disconnectCallReturn(ch.id)
    const trackId = laneOfChannel.current.get(ch.id)
    if (trackId) {
      laneOfChannel.current.delete(ch.id)
      engine.disconnectInput(trackId)
      removeLane(trackId)
    }
  }

  const disconnect = () => {
    const link = linkRef.current
    linkRef.current = null
    try {
      link?.leave()
    } catch {
      /* já era */
    }
    if (engine) {
      for (const [id, trackId] of [...laneOfChannel.current]) {
        laneOfChannel.current.delete(id)
        try {
          engine.disconnectInput(trackId)
          removeLane(trackId)
        } catch {
          /* a faixa pode já ter ido junto com o projeto */
        }
      }
      for (const id of [...engine.callReturnKeys()]) engine.disconnectCallReturn(id)
      engine.releaseCallCable()
    }
    setLive(false)
    setPeers([])
    setInvite('')
    setPrivateRoom(false)
  }

  const connect = async () => {
    if (!engine) {
      setError('a engine de áudio ainda não existe nesta janela')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    const base = server.trim().replace(/\/+$/, '')
    try {
      const mod = (await import(/* @vite-ignore */ `${base}/js/sala-sdk.js`)) as {
        joinRoom: (opts: Record<string, unknown>) => Promise<SalaLink>
      }
      const { send } = engine.ensureCallCable()
      const link = await mod.joinRoom({
        url: base,
        room: room.trim() || 'geral',
        name: name.trim() || 'Minha DAW',
        pass: pass.trim(),
        audioContext: engine.ctx,
        mode: 'jam',
        ice: hostOnly ? { hostOnly: true } : { stun: 'stun:stun.l.google.com:19302' },
      })
      linkRef.current = link
      link.useNode(send, { kind: 'daw', trimDb })
      link.setLimiter(limiter)
      // o mudo do cabo mora no engine, não no SDK: os dois ganhos se multiplicam
      // e um deles tem que ser o botão visível da janela.
      engine.setCallSendMuted(sendMuted)
      engine.setCallSendDb(trimDb)
      setPrivateRoom(link.state.isPrivate === true)
      setInvite(link.state.isPrivate ? link.inviteLink() : '')
      if (micAlong) {
        try {
          await link.useMicrophone()
          setNotice('microfone somado ao envio — fale com a DAW tocando baixinho, senão vira microfonia')
        } catch (err) {
          setNotice(`microfone negado (${(err as Error).name || (err as Error).message}) — seguindo só com a master`)
        }
      }
      link.on('channel', (event) => {
        patchChannel(event.detail as SalaChannel)
        refreshPeers()
      })
      link.on('channel-lost', (event) => {
        unpatchChannel(event.detail as SalaChannel)
        refreshPeers()
      })
      link.on('peer', refreshPeers)
      link.on('welcome', refreshPeers)
      link.on('status', (event) => {
        const state = (event as CustomEvent<{ state?: string }>).detail?.state
        if (state === 'closed' || state === 'error') setNotice('a sinalização caiu — o cabo continua montado, reconecte quando a rede voltar')
      })
      localStorage.setItem(STORE_KEY, JSON.stringify({ server: base, room, name, lanes }))
      setLive(true)
      refreshPeers()
    } catch (err) {
      const message = (err as Error)?.message || 'falha ao conectar'
      // o erro mais comum é o certificado autoassinado ainda não aceito, e o
      // navegador diz apenas "Failed to fetch" — vale traduzir.
      setError(
        /fetch|import|network|certificate/i.test(message)
          ? `não deu para alcançar ${base} — abra essa URL em uma aba, aceite o aviso do certificado autoassinado e tente de novo (${message})`
          : message,
      )
      disconnect()
    } finally {
      setBusy(false)
    }
  }

  // O app precisa saber se o cabo está no ar com a janela fechada — é a luz do
  // jack no master, e ela não pode piscar para uma chamada que já caiu.
  useEffect(() => {
    onLiveChange?.(live)
  }, [live, onLiveChange])

  // medidores do cabo: ida e volta, no ritmo do desenho da tela. Para de ler
  // quando a janela some — analisar dois FFTs por quadro sem ninguém olhando é
  // custo de áudio-thread por nada.
  useEffect(() => {
    if (!live || !engine || hidden) return
    let raf = 0
    const tick = () => {
      setSendPeak(engine.getCallSendLevel())
      setReturnPeak(engine.getCallReturnLevel())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [live, engine, hidden])

  useEffect(() => () => disconnect(), []) // eslint-disable-line react-hooks/exhaustive-deps

  // Escondida: o estado, a assinatura do SDK e os nós do engine continuam onde
  // estavam. Só não se desenha nada.
  if (hidden) return null

  const applyTrim = (value: number) => {
    setTrimDb(value)
    // um só lugar manda no nível: o ganho do cabo, no engine. Aplicar também o
    // trim do SDK seria um atenuador em série — dois -6 dB que somam -12.
    engine?.setCallSendDb(value)
  }
  const applyMute = () => {
    const next = !sendMuted
    setSendMuted(next)
    engine?.setCallSendMuted(next)
    // a porta do SDK também fecha, e é ela que avisa os outros: sem isso você
    // ficaria mudo na sala sem nenhum ícone de mudo em lugar nenhum.
    linkRef.current?.muteSend(next)
  }
  const applyLimiter = () => {
    const next = !limiter
    setLimiter(next)
    linkRef.current?.setLimiter(next)
  }
  const rename = (value: string) => {
    setName(value)
    linkRef.current?.setRoomName(value.trim() || 'Minha DAW')
  }

  return (
    <div className="modal-overlay" onClick={live ? undefined : onClose}>
      <div className="fx-window sala-window" onClick={(event) => event.stopPropagation()}>
        <div className="fx-header">
          <span>CABO VIRTUAL · MASTER → SALA</span>
          <button type="button" className="reaper-btn" onClick={onClose}>
            X
          </button>
        </div>

        <div className="sala-body">
          {live ? (
            <>
              <div className="sala-row sala-jack">
                <span className={`sala-led ${sendMuted ? 'off' : ''}`} />
                <b>enviando a master</b>
                <span className="sala-hint">
                  {privateRoom ? `sala privada · ${room}` : `sala aberta · ${room}`}
                  {linkRef.current?.state.instance ? ` · instância ${linkRef.current.state.instance}` : ''}
                </span>
              </div>

              <div className="sala-meters">
                <label className="sala-meter">
                  <span>IDA (o que a sala ouve)</span>
                  <div className="sala-bar">
                    <i style={{ width: `${Math.min(100, sendPeak * 140)}%` }} />
                  </div>
                </label>
                <label className="sala-meter">
                  <span>VOLTA (o que chega)</span>
                  <div className="sala-bar back">
                    <i style={{ width: `${Math.min(100, returnPeak * 140)}%` }} />
                  </div>
                </label>
              </div>

              <div className="sala-row">
                <button
                  type="button"
                  className={`reaper-btn ${sendMuted ? 'active-toggle' : ''}`}
                  onClick={applyMute}
                >
                  {sendMuted ? 'CABO FECHADO' : 'CABO ABERTO'}
                </button>
                <label className="sala-slider">
                  <span>envio {trimDb.toFixed(1)} dB</span>
                  <input
                    type="range"
                    min={-40}
                    max={6}
                    step={0.5}
                    value={trimDb}
                    onChange={(event) => applyTrim(Number(event.target.value))}
                  />
                </label>
                <button
                  type="button"
                  className={`reaper-btn ${limiter ? 'active-toggle' : ''}`}
                  onClick={applyLimiter}
                >
                  LIMIT
                </button>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={() => {
                    const applied = linkRef.current?.autoCompensate() || []
                    setNotice(applied.length ? `atraso aplicado: ${applied.map((a) => `${a.ms}ms`).join(' · ')}` : 'sem RTT medido ainda')
                  }}
                >
                  ALINHAR
                </button>
              </div>

              <div className="sala-row">
                <input
                  className="sala-name"
                  value={name}
                  onChange={(event) => rename(event.target.value)}
                  placeholder="seu nome na sala"
                  aria-label="nome na sala"
                />
                {privateRoom && invite ? (
                  <button
                    type="button"
                    className="reaper-btn"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(invite)
                        notify('link do convite copiado — a senha vai dentro')
                      } catch {
                        notify('copie manualmente: ' + invite)
                      }
                    }}
                  >
                    COPIAR CONVITE
                  </button>
                ) : null}
              </div>

              {privateRoom && invite ? <div className="sala-link">{invite}</div> : null}

              <div className="sala-peers">
                {peers.length === 0 ? (
                  <span className="sala-hint">ninguém mais na sala — o cabo está mudo por falta do que mandar</span>
                ) : (
                  peers.map((p) => (
                    <span key={p.id} className="sala-peer">
                      {p.name}
                      <em>
                        {p.channels.length} {p.channels.length === 1 ? 'canal' : 'canais'}
                      </em>
                    </span>
                  ))
                )}
              </div>

              <label className="sala-check">
                <input
                  type="checkbox"
                  checked={lanes}
                  onChange={(event) => {
                    const on = event.target.checked
                    setLanes(on)
                    if (!on) {
                      // desligou: devolve as faixas criadas, o retorno segue pelos alto-falantes
                      for (const [id, trackId] of [...laneOfChannel.current]) {
                        laneOfChannel.current.delete(id)
                        engine?.disconnectInput(trackId)
                        removeLane(trackId)
                      }
                    } else {
                      for (const ch of linkRef.current?.channels.values() || []) patchChannel(ch)
                    }
                  }}
                />
                <span>cada participante entra como faixa gravável (o monitor sai pela mixagem só na volta, sem eco)</span>
              </label>

              <div className="sala-row">
                <button type="button" className="reaper-btn danger" onClick={disconnect}>
                  DESCONECTAR
                </button>
                <span className="sala-hint">
                  {linkRef.current?.sendLevel ? `ida ${toDbText(linkRef.current.sendLevel().db)} dBFS` : ''}
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="sala-fields">
                <label>
                  <span>Servidor da sala</span>
                  <input value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://192.168.0.3:5250" />
                </label>
                <label>
                  <span>Sala</span>
                  <input value={room} onChange={(event) => setRoom(event.target.value)} placeholder="jam" />
                </label>
                <label>
                  <span>Senha do convite (se privada)</span>
                  <input
                    type="password"
                    value={pass}
                    onChange={(event) => setPass(event.target.value)}
                    placeholder="vazia = sala aberta"
                    autoComplete="off"
                  />
                </label>
                <label>
                  <span>Nome na sala</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Minha DAW" />
                </label>
              </div>

              <label className="sala-check">
                <input type="checkbox" checked={lanes} onChange={(event) => setLanes(event.target.checked)} />
                <span>criar uma faixa gravável para cada participante</span>
              </label>
              <label className="sala-check">
                <input type="checkbox" checked={micAlong} onChange={(event) => setMicAlong(event.target.checked)} />
                <span>mandar também o microfone junto com a master</span>
              </label>
              <label className="sala-check">
                <input type="checkbox" checked={hostOnly} onChange={(event) => setHostOnly(event.target.checked)} />
                <span>só rede local (sem STUN/TURN — mais rápido, não atravessa 4G)</span>
              </label>

              <div className="sala-row">
                <button type="button" className="reaper-btn primary" onClick={connect} disabled={busy || !engine}>
                  {busy ? 'ligando…' : 'LIGAR O CABO'}
                </button>
                {!engine ? <span className="sala-hint">a engine ainda não existe nesta janela</span> : null}
              </div>

              <p className="sala-hint">
                O que sai é a master inteira, depois do fader e dos FX do barramento — o que a sala ouve é exatamente o
                que sai da sua caixa. O que volta entra <b>depois</b> do ponto de envio, então ninguém escuta a própria
                bateria atrasada.
              </p>
            </>
          )}

          {error ? <div className="sala-error">{error}</div> : null}
          {notice ? <div className="sala-notice">{notice}</div> : null}
        </div>
      </div>
    </div>
  )
}
