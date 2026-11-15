.PHONY: check release-check

# 唯一检查入口：verifier 与 CI 只调用这个目标。
check:
	npm test
	node scripts/sync-backend-pins.mjs --verify-schema
	npm pack --dry-run >/dev/null

# 发版前门禁：TAG=vX.Y.Z，名称/版本/pin/CHANGELOG/annotated tag 全核对。
release-check: export TAG_VAL = $(TAG)
release-check:
	@if [ -z "$$TAG_VAL" ]; then echo "release-check: TAG is required (make release-check TAG=vX.Y.Z)"; exit 1; fi
	@[ "x$$(printf '%s' "$$TAG_VAL" | tr -d '\r\n')" = "x$$TAG_VAL" ] \
		|| { echo "release-check: TAG must be a single line without CR/LF"; exit 1; }
	@printf '%s' "$$TAG_VAL" | grep -qE '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$$' \
		|| { echo "release-check: TAG must match ^vX.Y.Z$$, got '$$TAG_VAL'"; exit 1; }
	@node -e "const p = require('./package.json'); if (p.name !== '@dorokuma/magpie-gemini-web') throw new Error('package name must be @dorokuma/magpie-gemini-web'); if ('v' + p.version !== process.env.TAG_VAL) throw new Error('package version ' + p.version + ' does not match TAG ' + process.env.TAG_VAL)"
	@node scripts/sync-backend-pins.mjs --verify-schema
	@version="$${TAG_VAL#v}"; \
		awk -v v="$$version" '\
			index($$0, "```") == 1 { fence = !fence; next } \
			!fence && index($$0, "## ") == 1 { \
				title = substr($$0, 4); \
				rest = substr(title, length(v) + 1); \
				hit = (index(title, v) == 1 && \
					(rest == "" || index(rest, " ") == 1 || index(rest, "\t") == 1 || \
					 index(rest, "(") == 1 || index(rest, "（") == 1)); \
				if (hit) found = 1; \
				insec = hit; \
				next } \
			!fence && insec && $$0 !~ /^[[:space:]]*$$/ && $$0 !~ /^###/ { body++ } \
			END { \
				if (!found) { print "missing '\''## " v "'\'' section"; exit 1 } \
				if (!body) { print "'\''## " v "'\'' section has no substantive content"; exit 1 } \
			}' CHANGELOG.md
	@if git rev-parse -q --verify "refs/tags/$$TAG_VAL" >/dev/null 2>&1; then \
		[ "$$(git cat-file -t "refs/tags/$$TAG_VAL")" = "tag" ] \
		|| { echo "release-check: tag $$TAG_VAL exists but is not annotated"; exit 1; }; \
		[ "$$(git rev-list -n 1 "refs/tags/$$TAG_VAL")" = "$$(git rev-parse HEAD)" ] \
		|| { echo "release-check: tag $$TAG_VAL does not point to HEAD"; exit 1; }; \
	fi
