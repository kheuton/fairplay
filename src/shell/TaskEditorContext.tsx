/**
 * FAIRPLAY · Task editor context.
 * ──────────────────────────────────────────────────────────────────────────
 * Holds the single "task currently being edited" for the whole app so ANY task
 * row — desktop or mobile, on any routed screen — can open the editor without
 * threading a callback down through the route tree.
 *
 * The editor SURFACE is rendered by each shell (EditTaskModal on desktop inside
 * AppShell, EditSheet on mobile inside MobileShell's .m-root) so it lands in the
 * correct positioning context. This provider owns ONLY the selected-task state.
 */
import React, { createContext, useContext, useState, useCallback } from 'react';
import type { FpTask } from '../lib/types';

interface TaskEditorValue {
  /** The task currently being edited, or null when the editor is closed. */
  task: FpTask | null;
  /** Open the editor for a task. */
  openEditor: (task: FpTask) => void;
  /** Close the editor. */
  closeEditor: () => void;
}

const TaskEditorContext = createContext<TaskEditorValue | null>(null);

export function TaskEditorProvider({ children }: { children: React.ReactNode }) {
  const [task, setTask] = useState<FpTask | null>(null);
  const openEditor = useCallback((t: FpTask) => setTask(t), []);
  const closeEditor = useCallback(() => setTask(null), []);
  return (
    <TaskEditorContext.Provider value={{ task, openEditor, closeEditor }}>
      {children}
    </TaskEditorContext.Provider>
  );
}

export function useTaskEditor(): TaskEditorValue {
  const ctx = useContext(TaskEditorContext);
  if (!ctx) throw new Error('useTaskEditor must be used within TaskEditorProvider');
  return ctx;
}
