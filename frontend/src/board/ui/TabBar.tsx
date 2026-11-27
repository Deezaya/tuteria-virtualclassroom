import { FileText, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BoardTab } from "../model/schema";

type TabBarProps = {
  tabs: readonly BoardTab[];
  current: string;
  /** Tutors and admins: add, rename and delete tabs. */
  canManage: boolean;
  /** Leading Mode is following the tutor, so tabs can't be switched. */
  switchLocked: boolean;
  onSwitch(id: string): void;
  onAdd(): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
  onRemovePdf(pdfId: string): void;
  describePdf(pdfId: string): { name: string; pages: number; tabs: number };
};

/** The board's pages, under the toolbar. */
export function TabBar(props: TabBarProps) {
  const { tabs, current, canManage, switchLocked } = props;
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [pdfMenu, setPdfMenu] = useState<{ tab: BoardTab; left: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the PDF menu on a click elsewhere or Escape.
  useEffect(() => {
    if (!pdfMenu) return;
    const close = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setPdfMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPdfMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [pdfMenu]);

  // Stop renaming a tab someone else deleted.
  useEffect(() => {
    if (renaming && !tabs.some((tab) => tab.id === renaming.id)) setRenaming(null);
  }, [renaming, tabs]);

  function finishRename() {
    if (!renaming) return;
    const name = renaming.draft.trim();
    const tab = tabs.find((candidate) => candidate.id === renaming.id);
    if (tab && name && name !== tab.name) props.onRename(tab.id, name);
    setRenaming(null);
  }

  function askDelete(tab: BoardTab, button: HTMLElement) {
    if (tab.pdfId) {
      const bar = barRef.current?.getBoundingClientRect();
      const at = button.getBoundingClientRect();
      setPdfMenu({ tab, left: bar ? Math.max(8, Math.min(at.left - bar.left - 120, bar.width - 268)) : 8 });
      return;
    }
    if (window.confirm(`Delete "${tab.name}" and everything on it? You can undo this.`)) {
      props.onDelete(tab.id);
    }
  }

  const canDeleteTab = (tab: BoardTab) => canManage && (tabs.length > 1 || tab.pdfId !== null);
  // One tab and nothing to manage: no bar.
  if (tabs.length <= 1 && !canManage) return null;
  const pdf = pdfMenu?.tab.pdfId ? props.describePdf(pdfMenu.tab.pdfId) : null;

  return (
    <div className="tb-tabbar" ref={barRef}>
      <div aria-label="Board pages" className="tb-tabs" role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === current;
          if (renaming?.id === tab.id) {
            return (
              <input
                aria-label="Tab name"
                autoFocus
                className="tb-tab-input"
                key={tab.id}
                maxLength={40}
                onBlur={finishRename}
                onChange={(event) => setRenaming({ id: tab.id, draft: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") finishRename();
                  if (event.key === "Escape") setRenaming(null);
                }}
                value={renaming.draft}
              />
            );
          }
          return (
            <div className={`tb-tab${active ? " is-active" : ""}`} key={tab.id}>
              <button
                aria-selected={active}
                className="tb-tab-name"
                disabled={switchLocked && !active}
                onClick={() => props.onSwitch(tab.id)}
                onDoubleClick={() => {
                  if (canManage) setRenaming({ id: tab.id, draft: tab.name });
                }}
                role="tab"
                title={canManage ? `${tab.name} (double-click to rename)` : tab.name}
                type="button"
              >
                {tab.pdfId && <FileText aria-hidden="true" size={13} />}
                <span>{tab.name}</span>
              </button>
              {canDeleteTab(tab) && (
                <button
                  aria-label={tab.pdfId ? `Remove ${tab.name}` : `Delete ${tab.name}`}
                  className="tb-tab-close"
                  onClick={(event) => askDelete(tab, event.currentTarget)}
                  title={tab.pdfId ? "Remove this tab or the whole PDF" : "Delete tab"}
                  type="button"
                >
                  <X aria-hidden="true" size={13} />
                </button>
              )}
            </div>
          );
        })}
        {canManage && (
          <button aria-label="Add a tab" className="tb-tab-add" onClick={props.onAdd} title="Add a tab" type="button">
            <Plus aria-hidden="true" size={15} />
          </button>
        )}
      </div>

      {pdfMenu && pdf && (
        <div className="tb-panel tb-tab-menu" ref={menuRef} role="dialog" aria-label="Remove PDF" style={{ left: pdfMenu.left }}>
          <p className="tb-panel-label">{pdf.name}</p>
          <div className="tb-menu">
            {tabs.length > 1 && (
              <button
                className="tb-menu-item"
                onClick={() => {
                  props.onDelete(pdfMenu.tab.id);
                  setPdfMenu(null);
                }}
                type="button"
              >
                <X aria-hidden="true" size={16} />
                <span>Remove only this tab</span>
              </button>
            )}
            <button
              className="tb-menu-item is-danger"
              onClick={() => {
                if (pdfMenu.tab.pdfId) props.onRemovePdf(pdfMenu.tab.pdfId);
                setPdfMenu(null);
              }}
              type="button"
            >
              <FileText aria-hidden="true" size={16} />
              <span>
                Remove the whole PDF ({pdf.pages} page{pdf.pages === 1 ? "" : "s"}
                {pdf.tabs > 0 ? `, ${pdf.tabs} tab${pdf.tabs === 1 ? "" : "s"}` : ""})
              </span>
            </button>
          </div>
          <p className="tb-tab-menu-note">Everything drawn on removed tabs goes too. You can undo this.</p>
        </div>
      )}
    </div>
  );
}
