import React from "react";
import type { PanelComponentProps } from "../../../../renderer/extensions/ExtensionPanelSlot";

interface AsanaTaskData {
  gid: string;
  name: string;
  completed: boolean;
  assignee: string | null;
  dueOn: string | null;
  url: string;
  projectName: string | null;
}

interface AsanaEnrichmentData {
  tasks: AsanaTaskData[];
  emailSubject: string;
  workspaceGid: string;
}

/**
 * Sidebar panel component for the Asana extension.
 *
 * Shows Asana tasks linked to the current email (by URL match or subject search).
 */
export function AsanaPanel({ enrichment, isLoading }: PanelComponentProps): React.ReactElement {
  if (isLoading) {
    return (
      <div className="p-3 text-sm text-gray-400">
        Searching Asana...
      </div>
    );
  }

  if (!enrichment?.data) {
    return (
      <div className="p-3 text-sm text-gray-500">
        No linked Asana tasks found.
      </div>
    );
  }

  const data = enrichment.data as unknown as AsanaEnrichmentData;
  const { tasks } = data;

  if (tasks.length === 0) {
    return (
      <div className="p-3 text-sm text-gray-500">
        No linked Asana tasks found.
      </div>
    );
  }

  return (
    <div className="p-2 space-y-2">
      {tasks.map((task) => (
        <a
          key={task.gid}
          href={task.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block p-2 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <div className="flex items-start gap-2">
            {/* Completion indicator */}
            <span
              className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                task.completed
                  ? "border-green-500 bg-green-500 text-white"
                  : "border-gray-400 dark:border-gray-500"
              }`}
            >
              {task.completed && (
                <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>

            <div className="min-w-0 flex-1">
              {/* Task name */}
              <div
                className={`text-sm font-medium truncate ${
                  task.completed ? "text-gray-400 line-through" : "text-gray-900 dark:text-gray-100"
                }`}
              >
                {task.name}
              </div>

              {/* Metadata row */}
              <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {task.projectName && (
                  <span className="truncate max-w-[120px]">{task.projectName}</span>
                )}
                {task.assignee && (
                  <>
                    {task.projectName && <span>·</span>}
                    <span className="truncate max-w-[100px]">{task.assignee}</span>
                  </>
                )}
                {task.dueOn && (
                  <>
                    <span>·</span>
                    <span>Due {task.dueOn}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
