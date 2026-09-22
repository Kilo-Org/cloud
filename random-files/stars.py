import random


def sky(n: int) -> list[str]:
    glyphs = [".", "*", "-", "+", "o", "🦄"]
    return ["".join(random.choice(glyphs) for _ in range(n)) for _ in range(n // 2)]


if __name__ == "__main__":
    for row in sky(80):
        print(row)
