// Osteosome 客户端壳（Tauri）。
//
// 定位：纯壳 —— 只负责打开主窗口 + 外部原生独立窗口(插件管理) + 托盘 + 全局快捷键。
// 一切业务（文件 / AI / 会话 / 记忆 / MCP / 插件装配）都在独立的 Node Core 进程里，
// 壳通过 HTTP/SSE (127.0.0.1:1420) 与 Core 通信，不碰业务数据。
//
// 架构：
//   Tauri 壳（Rust, 薄）  ── HTTP/SSE ──►  Node Core（龙骨, 一切业务）  ──►  远程/本地 LLM
//
// 窗口吸附：所有可独立出来的窗口（面板独立窗 osteosome-panel-* / 插件管理窗等）
// 在移动时若边缘距主窗 ≤ 13px 自动吸附贴边；吸附后主窗拖动时随之一起移动。
// 实现在本文件，挂在 Builder::on_window_event 上，前端无需轮询。
//
// 窗口外观：主窗口与所有浮窗均无系统边框（tauri.conf.json + WebviewWindow decorations:false），
// 由前端「窗口控制」组件（client/src/components/layout/WindowControls.vue）自绘最小化/最大化/关闭。
//
// 后续需扩展的能力（见 docs/wireframes/index.html）：
//   - 从插件管理窗口把组件跨窗口拖到主窗口 Panel
//   - 托盘 / 全局快捷键 / 系统集成
// 这些都在此文件 + capabilities 里按需添加，壳保持精简。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WindowEvent};

/// 主窗口 label（tauri.conf.json 的 windows 首项未指定 label，Tauri 默认即 "main"）。
const MAIN_WINDOW_LABEL: &str = "main";
/// 吸附阈值：独立窗任意边缘距主窗边缘 ≤ 13px（物理像素）即自动吸附贴边。
const SNAP_DISTANCE: i32 = 13;
/// 壳主动摆位后的静默时长：这段窗口内的 Moved 事件不再回送吸附判定，避免自吸附回环。
const FOLLOW_QUIET: Duration = Duration::from_millis(150);
/// 贴边瞬间广播的高亮事件（前端渲染脉冲，见 client/src/tauri/snap-feedback.ts）。
const SNAP_EVENT: &str = "ost:window-snap";
/// 面板独立窗 label 前缀（与 client/src/tauri/window-registry.ts 保持一致）。
const PANEL_WINDOW_PREFIX: &str = "osteosome-panel-";
/// 面板独立窗关闭时广播给主窗的事件：前端据此把面板 tab 放回工作台。
/// （事件名与 client/src/layout/window-manager.ts 保持一致。）
const PANEL_CLOSED_EVENT: &str = "ost:panel-window-closed";

/// 吸附方向：独立窗相对主窗的位置。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Side {
    Right,
    Left,
    Below,
    Above,
}

impl Side {
    /// (主窗贴边, 独立窗贴边)——告诉两侧窗口各自该亮哪条边。
    fn edges(self) -> (&'static str, &'static str) {
        match self {
            Side::Right => ("right", "left"),
            Side::Left => ("left", "right"),
            Side::Below => ("bottom", "top"),
            Side::Above => ("top", "bottom"),
        }
    }
}

/// 窗口矩形：x / y / 宽 / 高，均为物理像素（与 set_position / outer_position 一致）。
#[derive(Clone, Copy)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// 窗口帧：outer 是系统外框（Tauri 读写坐标用的），visible 是真实可见外框。
/// Windows 给普通窗口加了约 7px 不可见的调整边框，按 outer 贴边会留下视觉缝隙，
/// 因此吸附判定与落位都用 visible。
#[derive(Clone, Copy)]
struct Frame {
    outer: Rect,
    visible: Rect,
}

/// 吸附状态（挂在 App 上的全局单例）。
#[derive(Default)]
struct SnapState {
    /// 已吸附的独立窗：label -> 相对主窗左上角的偏移 (dx, dy)。
    attached: HashMap<String, (i32, i32)>,
    /// 壳刚主动摆位过的独立窗：label -> 时刻。
    quiet: HashMap<String, Instant>,
}

fn window_frame<R: Runtime>(win: &tauri::WebviewWindow<R>) -> Option<Frame> {
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let outer = Rect { x: pos.x, y: pos.y, w: size.width as i32, h: size.height as i32 };
    Some(Frame { outer, visible: visible_rect(win, outer) })
}

/// 真实可见外框：Windows 用 DWM 扩展边框去掉不可见调整边框；其它平台/失败时等于外框。
#[cfg(windows)]
fn visible_rect<R: Runtime>(win: &tauri::WebviewWindow<R>, outer: Rect) -> Rect {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    let Ok(hwnd) = win.hwnd() else { return outer };
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if ok.is_err() || r.right <= r.left || r.bottom <= r.top {
        return outer;
    }
    Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

#[cfg(not(windows))]
fn visible_rect<R: Runtime>(_win: &tauri::WebviewWindow<R>, outer: Rect) -> Rect {
    outer
}

/// 计算独立窗吸附到主窗后的方向与左上角坐标；不满足吸附条件返回 None。
///
/// 相邻方向需在垂直/水平方向上有重叠，避免仅角落接近就吸附。
/// 多个方向同时命中时取边缘间距最小者。
fn snap_target(main: Rect, child: Rect, dist: i32) -> Option<(Side, i32, i32)> {
    let (ml, mt, mr, mb) = (main.x, main.y, main.x + main.w, main.y + main.h);
    let (cl, ct, cr, cb) = (child.x, child.y, child.x + child.w, child.y + child.h);
    let v_overlap = ct < mb && mt < cb;
    let h_overlap = cl < mr && ml < cr;

    [
        v_overlap.then(|| ((cl - mr).abs(), Side::Right, mr, child.y)), // 贴主窗右侧
        v_overlap.then(|| ((cr - ml).abs(), Side::Left, ml - child.w, child.y)), // 贴主窗左侧
        h_overlap.then(|| ((ct - mb).abs(), Side::Below, child.x, mb)), // 贴主窗下方
        h_overlap.then(|| ((cb - mt).abs(), Side::Above, child.x, mt - child.h)), // 贴主窗上方
    ]
    .into_iter()
    .flatten()
    .filter(|(gap, ..)| *gap <= dist)
    .min_by_key(|(gap, ..)| *gap)
    .map(|(_, side, x, y)| (side, x, y))
}

/// 通知两侧窗口各做一次贴边高亮脉冲。
fn flash<R: Runtime>(app: &AppHandle<R>, child_label: &str, side: Side) {
    let (main_edge, child_edge) = side.edges();
    let _ = app.emit_to(MAIN_WINDOW_LABEL, SNAP_EVENT, main_edge);
    let _ = app.emit_to(child_label, SNAP_EVENT, child_edge);
}

/// 把「可见外框」目标坐标换算成 set_position 用的「外框」坐标。
fn outer_pos(child: Frame, visible: (i32, i32)) -> (i32, i32) {
    (
        visible.0 - (child.visible.x - child.outer.x),
        visible.1 - (child.visible.y - child.outer.y),
    )
}

/// 壳主动移动窗口并打静默标记，避免由此产生的 Moved 事件回送吸附判定。
fn place<R: Runtime>(state: &mut SnapState, label: &str, win: &tauri::WebviewWindow<R>, x: i32, y: i32) {
    state.quiet.insert(label.to_string(), Instant::now());
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// 记录吸附关系、贴边落位；若是「新吸附」再通知两侧窗口高亮。
///
/// `quiet`：主窗拖动引起的跟随落位要打静默标记（避免把跟随位移误判为独立窗自主移动而脱离）。
/// 独立窗自身拖动时的吸附落位**不**打静默——拖动过程中系统会持续用鼠标位置覆盖壳的摆位，
/// 只有松开鼠标后这一次落位才会真正生效；若把它静默掉，松开鼠标后的最后一帧 Moved 会被忽略，
/// 于是吸附处留下缝隙，非得等主窗再动一次才无缝。
fn attach<R: Runtime>(
    app: &AppHandle<R>,
    state: &mut SnapState,
    label: &str,
    win: &tauri::WebviewWindow<R>,
    main_outer: Rect,
    child: Frame,
    snapped: (Side, i32, i32),
    quiet: bool,
) {
    let (side, x, y) = snapped;
    let target = outer_pos(child, (x, y));
    let fresh = !state.attached.contains_key(label);
    state.attached.insert(label.to_string(), (target.0 - main_outer.x, target.1 - main_outer.y));
    if quiet {
        state.quiet.insert(label.to_string(), Instant::now());
    }
    // 已贴边则不再重复摆位，避免 set_position 触发的 Moved 形成回环。
    if (target.0, target.1) != (child.outer.x, child.outer.y) {
        let _ = win.set_position(PhysicalPosition::new(target.0, target.1));
    }
    if fresh {
        flash(app, label, side);
    }
}

/// 主窗移动：带着已吸附窗一起走，并顺带吸附邻近到阈值内的独立窗。
fn on_main_moved<R: Runtime>(app: &AppHandle<R>, state: &mut SnapState) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL).and_then(|w| window_frame(&w)) else { return };

    // 1) 已吸附的窗：按相对主窗的偏移整体平移。
    let attached: Vec<(String, (i32, i32))> = state.attached.iter().map(|(k, v)| (k.clone(), *v)).collect();
    for (label, (dx, dy)) in attached {
        let Some(win) = app.get_webview_window(&label) else {
            state.attached.remove(&label);
            state.quiet.remove(&label);
            continue;
        };
        place(state, &label, &win, main.outer.x + dx, main.outer.y + dy);
    }

    // 2) 尚未吸附但已进入 13px 的独立窗：吸附贴边。
    for (label, win) in app.webview_windows() {
        if label == MAIN_WINDOW_LABEL || state.attached.contains_key(&label) {
            continue;
        }
        let Some(child) = window_frame(&win) else { continue };
        if let Some(snapped) = snap_target(main.visible, child.visible, SNAP_DISTANCE) {
            attach(app, state, &label, &win, main.outer, child, snapped, true);
        }
    }
}

/// 独立窗自身移动：判定吸附 / 脱离。
fn on_child_moved<R: Runtime>(app: &AppHandle<R>, state: &mut SnapState, label: &str) {
    // 主窗拖动引起的跟随位移：静默期内直接跳过，避免把贴边误判为脱离。
    if let Some(at) = state.quiet.get(label) {
        if at.elapsed() < FOLLOW_QUIET {
            return;
        }
        state.quiet.remove(label);
    }

    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL).and_then(|w| window_frame(&w)) else { return };
    let Some(child_win) = app.get_webview_window(label) else { return };
    let Some(child) = window_frame(&child_win) else { return };

    match snap_target(main.visible, child.visible, SNAP_DISTANCE) {
        // 独立窗自主拖动：落位不静默，保证松开鼠标后的最后一次贴合能生效。
        Some(snapped) => attach(app, state, label, &child_win, main.outer, child, snapped, false),
        None => {
            state.attached.remove(label);
        }
    }
}

fn on_window_moved<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<Mutex<SnapState>>();
    let mut state = state.lock().unwrap();
    if label == MAIN_WINDOW_LABEL {
        on_main_moved(app, &mut state);
    } else {
        on_child_moved(app, &mut state, label);
    }
}

/// 从面板独立窗 URL 的 `#/pane/<id>?w=...` 取回面板 id。
fn panel_id_from_url<R: Runtime>(win: &tauri::WebviewWindow<R>) -> Option<String> {
    let url = win.url().ok()?;
    let path = url.fragment()?.split('?').next()?;
    path.strip_prefix("/pane/").map(str::to_string)
}

/// 面板独立窗被请求关闭：广播给主窗，让前端把对应的面板 tab 放回工作台。
/// 由壳统一监听窗口生命周期（与吸附同一处），前端无需 closeRequested 权限。
fn on_panel_window_closing<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if !label.starts_with(PANEL_WINDOW_PREFIX) {
        return;
    }
    let Some(panel_id) = app.get_webview_window(label).and_then(|w| panel_id_from_url(&w)) else {
        return;
    };
    let _ = app.emit_to(MAIN_WINDOW_LABEL, PANEL_CLOSED_EVENT, panel_id);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(SnapState::default()))
        .on_window_event(|window, event| {
            match event {
                WindowEvent::Moved(_) => on_window_moved(window.app_handle(), window.label()),
                WindowEvent::CloseRequested { .. } => {
                    on_panel_window_closing(window.app_handle(), window.label())
                }
                _ => {}
            }
        })
        .setup(|_app| {
            // 壳就绪后：主窗口自动加载 devUrl(5173) 或打包前端。
            // Core / Vite 由 start-client.cmd 负责启动，壳只做窗口。
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn snaps_flush_to_right_edge_when_within_threshold() {
        let main = rect(0, 0, 1000, 800);
        let child = rect(1006, 100, 400, 600); // 左边缘距主窗右边缘 6px
        assert_eq!(snap_target(main, child, SNAP_DISTANCE), Some((Side::Right, 1000, 100)));
    }

    #[test]
    fn snaps_flush_to_left_edge() {
        let main = rect(500, 0, 1000, 800);
        let child = rect(94, 100, 400, 300); // 右边缘距主窗左边缘 6px
        assert_eq!(snap_target(main, child, SNAP_DISTANCE), Some((Side::Left, 100, 100)));
    }

    #[test]
    fn snaps_flush_to_bottom_edge() {
        let main = rect(0, 0, 1000, 800);
        let child = rect(100, 804, 400, 300); // 上边缘距主窗下边缘 4px
        assert_eq!(snap_target(main, child, SNAP_DISTANCE), Some((Side::Below, 100, 800)));
    }

    #[test]
    fn snaps_flush_to_top_edge() {
        let main = rect(0, 500, 1000, 800);
        let child = rect(100, 195, 400, 300); // 下边缘距主窗上边缘 5px
        assert_eq!(snap_target(main, child, SNAP_DISTANCE), Some((Side::Above, 100, 200)));
    }

    #[test]
    fn ignores_when_gap_exceeds_threshold() {
        let main = rect(0, 0, 1000, 800);
        let child = rect(1015, 100, 400, 600); // 15px > 13px
        assert_eq!(snap_target(main, child, SNAP_DISTANCE), None);
    }

    #[test]
    fn ignores_corner_proximity_without_overlap() {
        let main = rect(0, 0, 1000, 800);
        let child = rect(1006, 806, 400, 300); // 对角靠近但无重叠
        assert_eq!(snap_target(main, child, SNAP_DISTANCE), None);
    }

    #[test]
    fn picks_smallest_gap_when_multiple_sides_eligible() {
        let main = rect(0, 0, 1000, 800);
        let child = rect(997, 799, 400, 300); // 与主窗轻微重叠：右侧差 3px、下方差 1px
        assert_eq!(snap_target(main, child, SNAP_DISTANCE), Some((Side::Below, 997, 800)));
    }

    #[test]
    fn converts_visible_target_to_outer_position() {
        // 子窗左侧不可见边框 7px：可见目标 x=1000 → 外框落位 993
        let child = Frame { outer: rect(100, 200, 400, 300), visible: rect(107, 200, 386, 293) };
        assert_eq!(outer_pos(child, (1000, 200)), (993, 200));
    }
}
