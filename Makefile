.PHONY: dev build run reset clean

PORT ?= 8080

# Запуск для разработки: собирает и стартует сервер (Ctrl+C — остановить)
dev:
	go run . -addr :$(PORT)

# Собрать бинарник ./svoi
build:
	go build -o svoi .

# Запустить собранный бинарник
run: build
	./svoi -addr :$(PORT)

# Начать игру заново (удалить сохранённый прогресс)
reset:
	rm -f state.json state.json.tmp

clean:
	rm -f svoi
