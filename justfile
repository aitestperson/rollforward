set dotenv-load

# List the recipes
default:
    @just --list

# Install the Node and Python dependencies
setup:
    npm install
    uv venv --allow-existing .venv
    uv pip install --python .venv/bin/python -r requirements.txt

# Serve a data root at http://127.0.0.1:PORT
start root port="8780":
    node src/server.ts '{{root}}' {{port}}

# Serve a scratch copy of the demo, made on first use; delete /tmp/rf-demo to start over
demo port="8780":
    [ -d /tmp/rf-demo ] || cp -r demo/snapshot /tmp/rf-demo
    node src/server.ts /tmp/rf-demo {{port}}

# Run the tests
test:
    node --test test/
