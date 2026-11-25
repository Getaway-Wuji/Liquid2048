import {
  ArrowLeft, ArrowRight, CircleHelp, History, LockKeyhole, Menu, Play, RotateCcw,
  Settings2, Sparkles, Trophy, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import TechText from '../react-bits/TechText';
import SquishSwitch from '../react-bits/SquishSwitch';
import { ARENA_HEIGHT, ARENA_WIDTH } from './arena';
import { initialHud, mountGame } from './game';
import type { GameControls } from './game';
import { achievements, compareScore, formatScore, readProfile, themes, unlocked, writeProfile } from './profile';
import type { Profile, RoundRecord, ThemeId } from './profile';
import { ballValue } from './wasm';

type Panel = 'menu' | 'settings' | 'help' | 'achievements' | 'history';
type Overlay = Panel | 'pause' | 'result';
const PANEL_TITLES: Record<Overlay, string> = {
  menu: '游戏菜单',
  pause: '游戏暂停', settings: '游戏设置', help: '操作指南',
  achievements: '成就与配色', history: '历史成绩', result: '液池已满',
};
const MENU_PANELS = [
  { page: 'help', icon: CircleHelp },
  { page: 'settings', icon: Settings2 },
  { page: 'achievements', icon: Trophy },
  { page: 'history', icon: History },
] as const;
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const localDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

function Modal({ panel, back, close, children }: { panel: Overlay; back?: () => void; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return (
    <dialog ref={ref} className="modal sb-modal" data-panel={panel} aria-labelledby="sb-dialog-title"
      onCancel={event => { event.preventDefault(); (back ?? close)(); }}>
      <div className="modal-box sb-modal-box">
        <div className="sb-modal-top">
          {back && <button className="btn btn-ghost btn-square sb-icon" type="button" aria-label="返回菜单" onClick={back}><ArrowLeft /></button>}
          <h2 id="sb-dialog-title">{PANEL_TITLES[panel]}</h2>
          {panel !== 'result' && <button className="btn btn-ghost btn-square sb-icon" type="button" aria-label="关闭" onClick={close}><X /></button>}
        </div>
        {children}
      </div>
    </dialog>
  );
}

function Help() {
  return (
    <>
      <p className="sb-dialog-copy">相同数值的液滴接触会合成。拆开的液滴合回原数值时，已计过的部分不会重复加分。</p>
      <dl className="sb-help">
        <div><dt>鼠标与触控</dt><dd>先选上方液滴，再拖动并松手发射。拖得越远，出射越快。满蓄力时，液滴在狭缝中会收窄、推挤两侧液滴，并保留更多前进速度。右键或「取消瞄准」可撤销瞄准。</dd></div>
        <div><dt>池内液滴</dt><dd>点按液滴可选中它并溅出小滴。长时间回不去的小滴可被碰到的其他液滴吸收，数字和得分不受影响。直接从液滴拖动，或选中后拖动空白处，松手即可短抛。快速连点三下可将 4 及以上的液滴对半拆分，最小数值为 2。</dd></div>
        <div><dt>键盘</dt><dd><kbd>1</kbd> 到 <kbd>4</kbd> 选择上方待发液滴。方向键瞄准，按 <kbd>+</kbd> 或 <kbd>−</kbd> 调力度。按住空格瞄准，松手发射或短抛。<kbd>Esc</kbd> 取消或暂停。</dd></div>
        <div><dt>手柄</dt><dd>LB / RB 切换待发液滴，左摇杆瞄准，右摇杆上下调力度。按住 A 瞄准，松手发射或短抛。B 取消，Start 暂停。</dd></div>
        <div><dt>上沿合成</dt><dd>四个圆点对应四个待发位。发射后，左侧液滴依次向右补位，新液滴从左端滑入。向斜上方发射可借弹板回弹合成同值液滴。本局最大数值提高后，补入的数值也可能提高。</dd></div>
        <div><dt>弹板与挡板</dt><dd>上方弹板会把液滴弹回液池。两侧挡板压满且所有入口持续堵塞两秒，本局结束。</dd></div>
      </dl>
    </>
  );
}

export default function App() {
  const [saved, setSaved] = useState(readProfile);
  const profile = saved.profile;
  const profileRef = useRef(profile);
  const [systemReduced, setSystemReduced] = useState(() => matchMedia(MOTION_QUERY).matches);
  const [hud, setHud] = useState(initialHud);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [toast, setToast] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<GameControls | null>(null);
  const toastTimeout = useRef(0);
  const theme = themes[profile.theme];
  const reducedMotion = profile.reducedMotion ?? systemReduced;
  const playing = hud.phase === 'playing';
  const overlay = panel ?? (hud.phase === 'paused' ? 'pause' : hud.phase === 'ended' ? 'result' : null);
  const waiting = hud.phase === 'loading' || hud.phase === 'ready' || hud.phase === 'failed';

  function updateProfile(update: (current: Profile) => Profile) {
    const next = update(profileRef.current);
    if (next === profileRef.current) return;
    profileRef.current = next;
    setSaved({ profile: next, storageOk: writeProfile(next) });
  }

  useEffect(() => {
    const query = matchMedia(MOTION_QUERY);
    const change = (event: MediaQueryListEvent) => setSystemReduced(event.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    if (!canvas.current) return;
    const preferences = profileRef.current;
    const controller = mountGame(canvas.current, {
      hud: setHud,
      archive(record: RoundRecord) {
        updateProfile(current => {
          const existing = current.rounds.find(round => round.id === record.id);
          if (existing?.reason === 'blocked' || (existing?.reason === record.reason && existing.shots === record.shots && existing.merges === record.merges)) return current;
          return { ...current, rounds: [record, ...current.rounds.filter(round => round.id !== record.id)] };
        });
      },
      progress(score, scoredMerges, flags, rackMerge) {
        const current = profileRef.current;
        const totalMerges = Math.min(Number.MAX_SAFE_INTEGER, current.totalMerges + scoredMerges);
        const active = flags(Math.min(totalMerges, 0xffffffff));
        const newlyUnlocked = achievements.filter((entry, index) => (active & (1 << index)) && !current.achievements.includes(entry.id));
        updateProfile(previous => ({
          ...previous,
          best: compareScore(score, previous.best) > 0 ? score : previous.best,
          totalMerges,
          achievements: [...previous.achievements, ...newlyUnlocked.map(item => item.id)],
        }));
        if (!newlyUnlocked.length || rackMerge) return false;
        setToast(`已解锁 ${newlyUnlocked.map(item => themes[item.theme].name).join('、')}`);
        window.clearTimeout(toastTimeout.current);
        toastTimeout.current = window.setTimeout(() => setToast(''), 4200);
        return true;
      },
    }, {
      theme: themes[preferences.theme],
      sound: preferences.sound,
      reducedMotion: preferences.reducedMotion ?? matchMedia(MOTION_QUERY).matches,
    });
    game.current = controller;
    return () => {
      controller.destroy();
      window.clearTimeout(toastTimeout.current);
      game.current = null;
    };
  }, []);

  useEffect(() => {
    game.current?.update({ theme, reducedMotion, sound: profile.sound });
  }, [theme, reducedMotion, profile.sound]);

  function focusArena() {
    requestAnimationFrame(() => canvas.current?.focus({ preventScroll: true }));
  }

  function start() {
    setPanel(null);
    setToast('');
    game.current?.start();
    focusArena();
  }

  function resume() {
    setPanel(null);
    game.current?.resume();
    focusArena();
  }

  function openMenu() {
    if (playing) {
      game.current?.pause();
      setPanel(null);
    } else {
      setPanel('menu');
    }
  }

  function closePanel() {
    if (hud.phase === 'paused') resume();
    else if (overlay !== 'result') setPanel(null);
  }

  function backToMenu() {
    setPanel(hud.phase === 'paused' ? null : 'menu');
  }

  function showTheme(id: ThemeId) {
    updateProfile(current => unlocked(current, id) ? { ...current, theme: id } : current);
  }

  const pointer = {
    onPointerMove: (event: ReactPointerEvent) => game.current?.pointerMove(event.nativeEvent),
    onPointerUp: (event: ReactPointerEvent) => game.current?.pointerUp(event.nativeEvent),
    onPointerCancel: (event: ReactPointerEvent) => game.current?.pointerCancel(event.nativeEvent),
    onLostPointerCapture: (event: ReactPointerEvent) => game.current?.pointerCancel(event.nativeEvent),
    onContextMenu: (event: React.MouseEvent) => game.current?.contextMenu(event.nativeEvent),
  };

  function beginPointer(event: ReactPointerEvent, slot?: number) {
    // React delegates events. The capture target is the element owning this handler.
    game.current?.pointerDown(event.nativeEvent, slot, event.currentTarget);
  }

  function slot(index: number) {
    const held = hud.rack[index];
    const { level } = held;
    const selected = hud.selected === index;
    const previous = hud.rack[index - 1];
    const next = hud.rack[index + 1];
    const halfWidth = Math.max(34, held.radius + 7);
    const leftSeam = previous?.radius
      ? (previous.x + previous.radius + held.x - held.radius) / 2
      : -Infinity;
    const rightSeam = next?.radius
      ? (held.x + held.radius + next.x - next.radius) / 2
      : Infinity;
    const left = Math.max(0, Math.min(held.x - 1, Math.max(held.x - halfWidth, leftSeam)));
    const right = Math.min(ARENA_WIDTH, Math.max(held.x + 1, Math.min(held.x + halfWidth, rightSeam)));
    return (
      <button key={index} type="button" className="sb-slot" data-level={level}
        data-testid={`slot-${index + 1}`}
        style={{ left: `${left / ARENA_WIDTH * 100}%`, top: `${held.y / ARENA_HEIGHT * 100}%`, width: `${(right - left) / ARENA_WIDTH * 100}%` }}
        aria-label={`待发 ${index + 1}，${level > 0 ? ballValue(level) : '空槽'}`}
        aria-pressed={selected} disabled={!playing || !level}
        onPointerDown={event => beginPointer(event, index)}
        onClick={event => { if (event.detail === 0) game.current?.select(index); }} {...pointer}>
        <span className="sb-rack-marker" aria-hidden="true" style={{
          left: `${(held.targetX - left) / ARENA_WIDTH * 100}cqw`,
          top: `calc(50% + ${(44 - held.y) / ARENA_WIDTH * 100}cqw)`,
        }} />
      </button>
    );
  }

  const visualStyle = {
    '--sb-accent': theme.accent, '--sb-danger': theme.danger, '--sb-board': theme.board, '--sb-grid': theme.grid,
  } as CSSProperties;
  const score = formatScore(hud.score);

  return (
    <div className="sb-app" data-theme="dark" data-motion={reducedMotion ? 'reduced' : 'full'} style={visualStyle}>
      <a href="#sb-game" className="sb-skip">跳到游戏</a>
      <main className="sb-layout" id="sb-game">
        <h1 className="sb-wordmark"><TechText text="liquid2048" reducedMotion={reducedMotion} /></h1>
        <button type="button" className="btn btn-ghost btn-square sb-icon sb-menu-trigger"
          title="菜单" aria-label="菜单" aria-haspopup="dialog" onClick={openMenu}><Menu /></button>

        <dl className="sb-score">
          <dt>得分</dt>
          <dd aria-live="polite" data-wide={score.length > 4}><span key={hud.score} data-testid="score" title={hud.score}>{score}</span></dd>
        </dl>

        <section className="sb-court" aria-label="数字液池" data-playing={playing}>
          <canvas ref={canvas} className="sb-arena" data-testid="arena" tabIndex={0}
            aria-label={waiting ? '液滴动画，点按可以让液体散开' : '数字液池，点按池内液滴可选中，拖动并松手可短抛。选中上方液滴后拖动可发射。'}
            onPointerLeave={() => game.current?.pointerLeave()}
            onPointerDown={event => beginPointer(event)} {...pointer} />
          {!waiting && (
            <div className="sb-queue" role="group" aria-label="待发液滴">
              {hud.rack.map((_, index) => slot(index))}
            </div>
          )}
          <div className="sb-feedback" role="status">
            {hud.danger > 0 && hud.phase !== 'ended'
              ? <span className="badge sb-danger">入口堵塞 {(Math.max(0, 2 - hud.danger)).toFixed(1)} 秒</span>
              : hud.message && <span className="badge sb-notice">{hud.message}</span>}
          </div>
          {waiting && (
            <div className="sb-start">
              {hud.phase === 'loading' && <button type="button" className="btn sb-primary" disabled>正在加载物理引擎</button>}
              {hud.phase === 'ready' && <>
                <button type="button" className="btn btn-primary sb-primary" onClick={start}><Play />开始游戏</button>
                <p>拖动发射，相同数字相融</p>
              </>}
              {hud.phase === 'failed' && <>
                <p role="alert">物理引擎加载失败。</p>
                <button type="button" className="btn btn-primary sb-primary" onClick={() => void game.current?.retry()}><RotateCcw />重试加载</button>
              </>}
            </div>
          )}
          {hud.power !== null && <button type="button" className="btn btn-ghost btn-square sb-icon sb-cancel"
            data-liquid-cancel="" aria-label="取消瞄准" title="取消瞄准" onClick={() => game.current?.cancel()}><X /></button>}
        </section>
        <div className="sr-only">
          <dl>
            <dt>合成次数</dt><dd data-testid="merges">{hud.merges}</dd>
            <dt>发射次数</dt><dd data-testid="shots">{hud.shots}</dd>
          </dl>
          {hud.pad !== 'none' && <p role="status">{hud.pad === 'standard' ? '手柄已连接' : '手柄映射未知，请使用其他输入'}</p>}
        </div>
      </main>

      {toast && <div role="status" className="alert sb-toast"><Sparkles />{toast}</div>}

      {overlay && <Modal key={overlay} panel={overlay} close={closePanel}
        back={overlay === 'pause' || overlay === 'menu' || overlay === 'result' ? undefined : backToMenu}>
        {overlay === 'help' && <Help />}
        {overlay === 'settings' && (
          <div className="sb-settings">
            <div><span>游戏音效</span><SquishSwitch ariaLabel="游戏音效" checked={profile.sound}
              trackColor={theme.grid} trackOnColor={theme.accent} reducedMotion={reducedMotion}
              width={62} height={34} onChange={sound => updateProfile(current => ({ ...current, sound }))} /></div>
            <div><span>减少动态效果</span><SquishSwitch ariaLabel="减少动态效果" checked={reducedMotion}
              trackColor={theme.grid} trackOnColor={theme.accent} reducedMotion={reducedMotion}
              width={62} height={34} onChange={setting => updateProfile(current => ({ ...current, reducedMotion: setting }))} /></div>
          </div>
        )}
        {overlay === 'achievements' && (
          <div className="sb-achievements">
            <button type="button" className="btn btn-ghost sb-theme" aria-pressed={profile.theme === 'soda'} onClick={() => showTheme('soda')}>
              <i style={{ backgroundColor: themes.soda.accent }} /><span>{themes.soda.name}<small>默认配色</small></span>
              {profile.theme === 'soda' && <span className="badge">使用中</span>}
            </button>
            {achievements.map(entry => {
              const available = unlocked(profile, entry.theme);
              return (
                <button type="button" key={entry.id} className="btn btn-ghost sb-theme" aria-pressed={profile.theme === entry.theme}
                  aria-label={themes[entry.theme].name} disabled={!available} onClick={() => showTheme(entry.theme)}>
                  <i style={{ backgroundColor: themes[entry.theme].accent }} />
                  <span>{themes[entry.theme].name}<small>{entry.title} · {entry.goal}</small></span>
                  {!available && <LockKeyhole aria-label="未解锁" />}
                  {profile.theme === entry.theme && <span className="badge">使用中</span>}
                </button>
              );
            })}
          </div>
        )}
        {overlay === 'history' && (
          profile.rounds.length ? <div className="sb-history">
            {profile.rounds.map(round => (
              <article key={round.id}>
                <div><time dateTime={new Date(round.endedAt).toISOString()}>{localDate.format(round.endedAt)}</time>
                  <p>{round.reason === 'blocked' ? '液池已满' : '主动中止'} · 最大数值 {ballValue(round.highestLevel)} · 合成 {round.merges} 次 · 发射 {round.shots} 次</p></div>
                <strong title={round.score}>{formatScore(round.score)}</strong>
              </article>
            ))}
          </div> : <p className="sb-dialog-copy">完成或离开一局游戏后，成绩会显示在这里。</p>
        )}
        {(overlay === 'pause' || overlay === 'menu' || overlay === 'result') && (
          <>
            <dl className="sb-menu-stats">
              {overlay === 'result' && <div><dt>最终分数</dt><dd title={hud.score}>{formatScore(hud.score)}</dd></div>}
              <div><dt>最高分</dt><dd data-testid="best" title={profile.best}>{formatScore(profile.best)}</dd></div>
              {overlay !== 'menu' && <>
                <div><dt>最大数值</dt><dd>{ballValue(hud.highestLevel)}</dd></div>
                <div><dt>合成</dt><dd>{hud.merges}</dd></div>
                <div><dt>发射</dt><dd>{hud.shots}</dd></div>
              </>}
            </dl>
            {overlay === 'pause' && <button type="button" className="btn btn-primary sb-primary sb-resume" onClick={resume}><Play />继续游戏</button>}
            {overlay === 'result' && <button type="button" className="btn btn-primary sb-primary sb-resume" onClick={start}><RotateCcw />重新开始</button>}
            <ul className="list sb-menu-list" aria-label="游戏选项">
              {overlay !== 'result' && MENU_PANELS.map(({ page, icon: Icon }) => (
                <li key={page}><button type="button" className="btn btn-ghost sb-menu-link" onClick={() => setPanel(page)}>
                  <Icon /><span>{PANEL_TITLES[page]}</span><ArrowRight aria-hidden="true" />
                </button></li>
              ))}
              {overlay === 'pause' && <li><button type="button" className="btn btn-ghost sb-menu-link" onClick={start}>
                <RotateCcw /><span>重新开始</span>
              </button></li>}
              <li><a className="btn btn-ghost sb-menu-link" href="https://game.grace-spring.top/" onClick={() => game.current?.leave()}>
                <ArrowLeft /><span>返回游戏大厅</span>
              </a></li>
            </ul>
            {!saved.storageOk && <p className="sb-dialog-copy" role="status">本机存储不可用，刷新后可能丢失成绩与设置。</p>}
          </>
        )}
      </Modal>}
    </div>
  );
}
