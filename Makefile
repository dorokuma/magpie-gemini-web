.PHONY: check

# 唯一检查入口：verifier 与 CI 只调用这个目标。
check:
	npm test
