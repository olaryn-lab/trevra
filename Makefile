# Agent workflow: see AGENTS.md.
.PHONY: verify verify-all

verify: ## Checks affected by HEAD and uncommitted work vs origin/main (the pre-push gate)
	@git config core.hooksPath .githooks
	@.githooks/pre-push < /dev/null

verify-all: ## Every check in .githooks/verify.rules
	@git config core.hooksPath .githooks
	@VERIFY_ALL=1 .githooks/pre-push < /dev/null
