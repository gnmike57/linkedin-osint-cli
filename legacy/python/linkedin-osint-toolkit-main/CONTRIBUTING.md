# Contributing

Thanks for your interest in contributing to the LinkedIn OSINT Toolkit!

## Getting Started

```bash
# Clone the repo
git clone https://github.com/OWNER/linkedin-osint-toolkit.git
cd linkedin-osint-toolkit

# Create a virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
make install-dev
```

## Development Workflow

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Run the linter: `make lint`
4. Run tests: `make test`
5. Commit and push your branch
6. Open a Pull Request against `main`

## Code Style

- Follow PEP 8 (enforced by ruff)
- Maximum line length: 120 characters
- Use type hints where practical

## Commit Messages

- Use present tense ("Add feature" not "Added feature")
- Keep the first line under 72 characters
- Reference related issues with `#123`

## Reporting Issues

- Use the GitHub issue templates (Bug Report / Feature Request)
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)
