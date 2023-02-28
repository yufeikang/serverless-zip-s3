const AWS = require("aws-sdk");
const stream = require("stream");
const archiver = require("archiver");
const https = require("https");
const lazystream = require("lazystream");

const agent = new https.Agent({ keepAlive: true, maxSockets: 16 });

AWS.config.update({ httpOptions: { agent } });

const s3 = new AWS.S3();

module.exports.app = async (event, context, callback) => {
    let { bucket, inputDir, files, inputBucket, outputBucket } = event;
    const { outputKey } = event;
    if (!inputBucket) {
        inputBucket = bucket;
    }
    if (!outputBucket) {
        outputBucket = bucket;
    }
    if (!inputBucket || !outputBucket) {
        throw new Error("Missing bucket name");
    }

    console.log(
        `inputBucket: ${inputBucket}, outputBucket: ${outputBucket}, inputDir: ${inputDir}, outputKey: ${outputKey}`
    );

    if (inputDir) {
        files = await listObjects(inputBucket, inputDir);
    }
    if (!files || files.length === 0) {
        throw new Error("Missing files, or inputDir is empty");
    }

    console.log(`input files size: ${files.length}`);

    const streamPassThrough = new stream.PassThrough();

    const uploadParams = {
        Body: streamPassThrough,
        ContentType: "application/zip",
        Key: outputKey,
        Bucket: outputBucket,
    };

    const s3Upload = s3.upload(uploadParams, (err) => {
        if (err) {
            console.error("upload error", err);
        } else {
            console.log("upload done");
        }
    });

    // get all input files streams
    const s3FileDownloadStreams = files.map((file) => {
        return {
            stream: new lazystream.Readable(() => {
                console.log(`input file: ${file.key}`);
                return s3
                    .getObject({ Bucket: inputBucket, Key: file.key })
                    .createReadStream();
            }),
            fileName: file.fileName,
        };
    });

    const archive = archiver("zip", {
        zlib: { level: 0 },
    });
    archive.on("error", (error) => {
        throw new Error(
            `${error.name} ${error.code} ${error.message} ${error.path}  ${error.stack}`
        );
    });

    archive.on("progress", (progress) => {
        console.log(
            `archive ${outputKey} progress: ${progress.entries.processed} / ${progress.entries.total}`
        );
    });

    s3Upload.on("httpUploadProgress", (progress) => {
        console.log(`upload ${outputKey}, loaded size: ${progress.loaded}`);
        console.log(
            `memory usage: ${process.memoryUsage().heapUsed / 1024 / 1024} MB`
        );
    });

    await new Promise((resolve, reject) => {
        streamPassThrough.on("close", () => onEvent("close", resolve));
        streamPassThrough.on("end", () => onEvent("end", resolve));
        streamPassThrough.on("error", () => onEvent("error", reject));

        console.log("Starting upload");

        archive.pipe(streamPassThrough);
        s3FileDownloadStreams.forEach((ins) => {
            if (outputKey === ins.fileName) {
                console.warn(`skip output file: ${ins.fileName}`);
                // skip the output file, may be duplicating zip files
                return;
            }
            archive.append(ins.stream, { name: ins.fileName });
        });
        archive.finalize();
    }).catch((error) => {
        throw new Error(`${error.code} ${error.message} ${error.data}`);
    });
    console.log("Upload done");
    await s3Upload.promise();

    return {
        statusCode: 200,
        body: JSON.stringify({ outputKey }),
    };
};

const listObjects = async (bucket, prefix) => {
    console.log(`listObjects: ${bucket}, ${prefix}`);
    let params = {
        Bucket: bucket,
        Prefix: prefix,
    };
    const result = [];
    while (true) {
        let data = await s3.listObjectsV2(params).promise();
        result.push(
            ...data.Contents.map((item) => {
                const fileName = item.Key.replace(prefix, "");
                return { key: item.Key, fileName };
            })
        );
        if (!data.IsTruncated) {
            break;
        }
        params.ContinuationToken = data.NextContinuationToken;
    }
    return result;
};

const onEvent = (event, reject) => {
    console.log(`on: ${event}`);
    reject();
};
