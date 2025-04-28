import parseRange from 'range-parser';

interface Env {
	SNAPSHOT_ARCHIVE: R2Bucket;
	FOREST_ARCHIVE: R2Bucket;
}

function formatFileSize(size: number) {
	if (size < 1024) {
		return `${size} B`;
	} else if (size < 1000 * 1024) {
		return `${(size / 1024).toFixed(2)} KB`;
	} else if (size < 1000 * 1000 * 1024) {
		return `${(size / (1024 * 1024)).toFixed(2)} MB`;
	} else {
		return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}
}

async function do_listing(env: Env, bucket: R2Bucket, prefix: string, title: string = 'Filecoin Snapshots 14 days Archive') {
	const options = {
		limit: 500,
		prefix: prefix,
	};

	const listed = await bucket.list(options);
	console.log('Listed objects:', listed.objects);
	let truncated = listed.truncated;
	let cursor = listed.truncated ? listed.cursor : undefined;

	while (truncated) {
		const next = await bucket.list({
			...options,
			cursor: cursor,
		});
		listed.objects.push(...next.objects);

		truncated = next.truncated;
		cursor = next.truncated ? next.cursor : undefined;
	}

	let html = `<!DOCTYPE html>
        <body>
          <h1>${title}</h1>
          <ul>`;
	for (const obj of listed.objects) {
		const fileSize = formatFileSize(obj.size);
		html += `<li><a href="/archive/${bucket === env.SNAPSHOT_ARCHIVE ? 'snapshot' : 'forest'}/${obj.key}">${obj.key}</a> ${fileSize} </li>\n`;
	}
	html += `</ul></body>`;

	return new Response(html, {
		headers: {
			'content-type': 'text/html;charset=UTF-8',
		},
	});
}

async function fetch_file(env: Env, bucket: R2Bucket, path: string, request: Request): Promise<Response> {
	const object = await bucket.get(path);

	if (!object) {
		return new Response(`File not found: ${path}`, { status: 404 });
	}

	const headers = new Headers();
	headers.set('Content-Type', object.httpMetadata.contentType || 'application/octet-stream');
	headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(path.split('/').pop()!)}"`);

	let status = 200;

	const rangeHeader = request.headers.get('range');
	if (rangeHeader) {
		const range = parseRange(object.size, rangeHeader);
		if (Array.isArray(range)) {
			if (range.length > 1) {
				return new Response('Multiple ranges are not supported', {
					status: 416, // Range Not Satisfiable
				});
			}

			const r = range[0];
			headers.set('Content-Range', `bytes ${r.start}-${r.end}/${object.size}`);
			headers.set('Content-Length', `${r.end - r.start + 1}`);
			status = 206; // Partial Content

			// Serve only the requested byte range
			const objectPart = await bucket.get(path, {
				range: { offset: r.start, length: r.end - r.start + 1 },
			});
			if (objectPart?.body) {
				return new Response(objectPart.body, { headers, status });
			}
		} else {
			headers.set('Content-Length', object.size.toString());
		}
	} else {
		headers.set('Content-Length', object.size.toString());
	}

	if ('body' in object) {
		return new Response(object.body, { headers, status });
	} else {
		return new Response(null, { headers, status });
	}
}

export default {
	async fetch(request: Request, env: Env) {
		switch (request.method) {
			case 'HEAD':
			case 'GET': {
				const url = new URL(request.url);
				const { pathname } = url;

				if (pathname.startsWith('/archive/')) {
					const [, , bucketType, ...filePathParts] = pathname.split('/');
					const filePath = filePathParts.join('/');
					const bucket = bucketType === 'snapshot' ? env.SNAPSHOT_ARCHIVE : env.FOREST_ARCHIVE;
					return fetch_file(env, bucket, filePath, request); // Pass the request object here
				}

				switch (pathname) {
					case '/list':
					case '/list/': {
						const html = `<!DOCTYPE html>
                        <body>
                        <h1>Filecoin Snapshots Archive</h1>
                        <ul>
                        <li><a href="/list/calibnet/latest">Calibnet Latest</a></li>
                        <li><a href="/list/mainnet/latest">Mainnet Latest</a></li>
                        <li><a href="/list/calibnet/diff">Calibnet Diff</a></li>
                        <li><a href="/list/mainnet/diff">Mainnet Diff</a></li>
                        <li><a href="/list/calibnet/lite">Calibnet Lite</a></li>
                        <li><a href="/list/mainnet/lite">Mainnet Lite</a></li>
                        </ul>
                        </body>`;
						return new Response(html, {
							headers: {
								'content-type': 'text/html;charset=UTF-8',
							},
						});
					}
					case '/list/mainnet/latest':
						return do_listing(env, env.SNAPSHOT_ARCHIVE, 'mainnet/latest');
					case '/list/calibnet/latest':
						return do_listing(env, env.SNAPSHOT_ARCHIVE, 'calibnet/latest');
					case '/list/mainnet/diff':
						return do_listing(env, env.FOREST_ARCHIVE, 'mainnet/diff', 'Filecoin Snapshots Archive');
					case '/list/calibnet/diff':
						return do_listing(env, env.FOREST_ARCHIVE, 'calibnet/diff', 'Filecoin Snapshots Archive');
					case '/list/mainnet/lite':
						return do_listing(env, env.FOREST_ARCHIVE, 'mainnet/lite', 'Filecoin Snapshots Archive');
					case '/list/calibnet/lite':
						return do_listing(env, env.FOREST_ARCHIVE, 'calibnet/lite', 'Filecoin Snapshots Archive');
					default:
						return new Response(`URL not found: ${pathname}`, { status: 404 });
				}
			}
			default: {
				return new Response('Method not allowed', {
					status: 405,
					headers: {
						Allow: 'GET, HEAD',
					},
				});
			}
		}
	},
};
