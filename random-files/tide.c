#include <stdio.h>
#include <math.h>

int main(void) {
    for (int h = 0; h < 24; h++) {
        double level = 2.4 * sin(h * 3.14159 / 6.0) + 1.1;
        printf("%02d:00  %5.2f m  %s\n", h, level,
               level > 2.0 ? "high" : "low");
    }
    return 0;
}
