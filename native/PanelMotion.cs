namespace PiRelay;
// What a tray click does depends on where the panel's slide is: a click while it slides in is
// ignored, a click while it slides out reverses it from the current position.
public enum PanelPhase { Hidden, Revealing, Visible, Collapsing }
public enum PanelAction { Ignore, Collapse, Reverse, Reveal }
public static class PanelMotion {
 public static PanelAction OnTrayClick(PanelPhase phase)=>phase switch{
  PanelPhase.Revealing=>PanelAction.Ignore,
  PanelPhase.Visible=>PanelAction.Collapse,
  PanelPhase.Collapsing=>PanelAction.Reverse,
  _=>PanelAction.Reveal,
 };
 // The in-panel collapse button, Escape and the window close request.
 public static bool MayCollapse(PanelPhase phase)=>phase==PanelPhase.Visible;
}
