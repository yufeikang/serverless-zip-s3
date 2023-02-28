export PATH="node_modules/.bin:$PATH"

if [ -f data.json ]; then
    echo "Use data.json"
    data=$(cat data.json)
else
    echo "Please create data.json file"
    exit 1
fi

sls invoke local --function app --data "$data"
