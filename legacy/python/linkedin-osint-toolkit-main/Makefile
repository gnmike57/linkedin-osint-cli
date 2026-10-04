.PHONY: install install-dev lint format typecheck test clean help

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install production dependencies
	pip install -r requirements.txt

install-dev: ## Install production + dev dependencies
	pip install -r requirements.txt
	pip install ruff mypy pytest

lint: ## Run ruff linter
	ruff check src/ tests/

format: ## Auto-format code with ruff
	ruff format src/ tests/

typecheck: ## Run mypy type checker
	mypy src/

test: ## Run test suite with pytest
	pytest tests/ -v

clean: ## Remove build artifacts and caches
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .mypy_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .ruff_cache -exec rm -rf {} + 2>/dev/null || true
	rm -rf build/ dist/ *.egg-info htmlcov/ .coverage
