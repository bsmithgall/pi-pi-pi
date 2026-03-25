-- diffview.nvim + pi-nvim for code review workflow with pi coding agent
-- Managed by pi review extension (symlinked by /review setup).
-- Pick layout based on terminal width. The launcher script exports
-- DIFFVIEW_COLS with the pane's column count before starting nvim.
local cols = tonumber(vim.env.DIFFVIEW_COLS) or 120
local layout = cols >= 160 and "diff2_horizontal" or "diff2_vertical"

---@type LazySpec
return {
  {
    "dlyongemallo/diffview.nvim",
    cmd = { "DiffviewOpen", "DiffviewFileHistory" },
    opts = {
      default_args = {
        DiffviewOpen = { "--imply-local" },
      },
      view = {
        default = { layout = layout },
        file_history = { layout = layout },
      },
      hooks = {
        diff_buf_win_enter = function(bufnr, winid, ctx)
          -- Hide sign column in diff buffers to avoid color mismatches
          vim.api.nvim_set_option_value("signcolumn", "no", { win = winid })
          -- Disable snacks indent guides in diff buffers — they create
          -- highlight boundaries in whitespace that cause cursorline
          -- underline rendering artifacts (zebra stripe effect)
          vim.b[bufnr].snacks_indent = false

          -- Use space for diff filler lines instead of "----"
          vim.opt_local.fillchars:append({ diff = " " })
        end,
      },
    },
  },
  {
    "carderne/pi-nvim",
    config = function()
      require("pi-nvim").setup()
    end,
  },
}
