import { z } from "zod";
import { type ToolDefinition, ToolRiskLevel } from "./types";

const createAsanaTask: ToolDefinition<{
  name: string;
  notes?: string;
  assignee?: string;
  dueOn?: string;
  projects?: string[];
}> = {
  name: "create_asana_task",
  description:
    "Create a new task in Asana. Use this when the user asks to create a task from an email, " +
    "assign work, or track action items in Asana. The task will be created in the user's " +
    "configured workspace. Always confirm with the user before creating.",
  category: "external",
  riskLevel: ToolRiskLevel.HIGH,
  inputSchema: z.object({
    name: z.string().describe("Task name/title"),
    notes: z
      .string()
      .optional()
      .describe("Task description/notes. Include relevant context from the email."),
    assignee: z
      .string()
      .optional()
      .describe("Assignee name or email. If not specified, the task is unassigned."),
    dueOn: z
      .string()
      .optional()
      .describe("Due date in YYYY-MM-DD format. Only set if a deadline is mentioned."),
    projects: z
      .array(z.string())
      .optional()
      .describe("Project GIDs to add the task to. Usually not needed — tasks go to the workspace."),
  }),
  async execute(input, ctx) {
    // Get the configured workspace ID
    const workspaceGid = (await ctx.db("asanaGetWorkspaceId")) as string | null;
    if (!workspaceGid) {
      throw new Error(
        "No Asana workspace configured. Go to Settings > Extensions > Asana and enter your Workspace GID.",
      );
    }

    const task = await ctx.db(
      "asanaCreateTask",
      workspaceGid,
      input.name,
      input.notes,
      input.assignee,
      input.dueOn,
      input.projects,
    );

    return task;
  },
};

const searchAsanaTasks: ToolDefinition<{
  query: string;
  maxResults?: number;
}> = {
  name: "search_asana_tasks",
  description:
    "Search for existing tasks in Asana by text query. Use this to find related tasks, " +
    "check if a task already exists, or look up task details before creating duplicates.",
  category: "external",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    query: z.string().describe("Search query text to match against task names and descriptions"),
    maxResults: z.number().optional().describe("Maximum number of results (default 5)"),
  }),
  async execute(input, ctx) {
    const workspaceGid = (await ctx.db("asanaGetWorkspaceId")) as string | null;
    if (!workspaceGid) {
      throw new Error(
        "No Asana workspace configured. Go to Settings > Extensions > Asana and enter your Workspace GID.",
      );
    }

    const tasks = await ctx.db(
      "asanaSearchTasks",
      workspaceGid,
      input.query,
      input.maxResults ?? 5,
    );

    return tasks;
  },
};

const listAsanaWorkspaces: ToolDefinition<Record<string, never>> = {
  name: "list_asana_workspaces",
  description:
    "List available Asana workspaces. Use this to help the user find their workspace GID " +
    "if they haven't configured it yet.",
  category: "external",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const workspaces = await ctx.db("asanaListWorkspaces");
    return workspaces;
  },
};

const updateAsanaTask: ToolDefinition<{
  taskGid: string;
  name?: string;
  notes?: string;
  assignee?: string;
  dueOn?: string | null;
  completed?: boolean;
}> = {
  name: "update_asana_task",
  description:
    "Update an existing Asana task. Can change the name, notes, assignee, due date, or completion status. " +
    "Use this when the user asks to modify a task, change a due date, mark a task complete, reassign it, etc. " +
    "You need the task GID — use search_asana_tasks or extract it from an Asana URL in the email first.",
  category: "external",
  riskLevel: ToolRiskLevel.HIGH,
  inputSchema: z.object({
    taskGid: z.string().describe("The Asana task GID to update"),
    name: z.string().optional().describe("New task name"),
    notes: z.string().optional().describe("New task description/notes (replaces existing)"),
    assignee: z.string().optional().describe("New assignee (name or email)"),
    dueOn: z
      .string()
      .nullable()
      .optional()
      .describe("New due date in YYYY-MM-DD format, or null to clear the due date"),
    completed: z.boolean().optional().describe("Set to true to mark complete, false to reopen"),
  }),
  async execute(input, ctx) {
    const { taskGid, ...params } = input;
    const task = await ctx.db(
      "asanaUpdateTask",
      taskGid,
      params.name,
      params.notes,
      params.assignee,
      params.dueOn,
      params.completed,
    );
    return task;
  },
};

const addAsanaComment: ToolDefinition<{
  taskGid: string;
  text: string;
}> = {
  name: "add_asana_comment",
  description:
    "Add a comment to an existing Asana task. Use this to add context from an email, " +
    "leave a note, or link an email discussion to a task.",
  category: "external",
  riskLevel: ToolRiskLevel.MEDIUM,
  inputSchema: z.object({
    taskGid: z.string().describe("The Asana task GID to comment on"),
    text: z.string().describe("The comment text to add"),
  }),
  async execute(input, ctx) {
    await ctx.db("asanaAddComment", input.taskGid, input.text);
    return { success: true, message: `Comment added to task ${input.taskGid}` };
  },
};

export const tools: ToolDefinition[] = [
  createAsanaTask as ToolDefinition,
  updateAsanaTask as ToolDefinition,
  addAsanaComment as ToolDefinition,
  searchAsanaTasks as ToolDefinition,
  listAsanaWorkspaces as ToolDefinition,
];
