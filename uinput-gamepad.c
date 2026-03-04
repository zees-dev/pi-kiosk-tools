/* uinput-gamepad: creates a virtual gamepad and reads events from stdin.
 * Protocol: 24-byte input_event structs (aarch64: timeval(16) + type(2) + code(2) + value(4))
 * Standard Xbox-style layout: 2 sticks, 2 triggers, d-pad, 11 buttons.
 */
#include <linux/uinput.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <signal.h>

static int ufd = -1;

void cleanup(int sig) {
    if (ufd >= 0) {
        ioctl(ufd, UI_DEV_DESTROY);
        close(ufd);
    }
    _exit(0);
}

static void set_abs(int fd, int code, int min, int max, int flat, int fuzz) {
    struct uinput_abs_setup abs = {0};
    abs.code = code;
    abs.absinfo.minimum = min;
    abs.absinfo.maximum = max;
    abs.absinfo.flat = flat;
    abs.absinfo.fuzz = fuzz;
    ioctl(fd, UI_ABS_SETUP, &abs);
}

int main(int argc, char *argv[]) {
    signal(SIGINT, cleanup);
    signal(SIGTERM, cleanup);
    signal(SIGPIPE, SIG_IGN);

    ufd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (ufd < 0) { perror("open /dev/uinput"); return 1; }

    /* Enable event types */
    ioctl(ufd, UI_SET_EVBIT, EV_KEY);
    ioctl(ufd, UI_SET_EVBIT, EV_ABS);
    ioctl(ufd, UI_SET_EVBIT, EV_SYN);

    /* Buttons — standard gamepad */
    ioctl(ufd, UI_SET_KEYBIT, BTN_SOUTH);   /* A / Cross */
    ioctl(ufd, UI_SET_KEYBIT, BTN_EAST);    /* B / Circle */
    ioctl(ufd, UI_SET_KEYBIT, BTN_NORTH);   /* Y / Triangle */
    ioctl(ufd, UI_SET_KEYBIT, BTN_WEST);    /* X / Square */
    ioctl(ufd, UI_SET_KEYBIT, BTN_TL);      /* L1 / LB */
    ioctl(ufd, UI_SET_KEYBIT, BTN_TR);      /* R1 / RB */
    ioctl(ufd, UI_SET_KEYBIT, BTN_TL2);     /* L2 digital */
    ioctl(ufd, UI_SET_KEYBIT, BTN_TR2);     /* R2 digital */
    ioctl(ufd, UI_SET_KEYBIT, BTN_SELECT);  /* Select / Share */
    ioctl(ufd, UI_SET_KEYBIT, BTN_START);   /* Start / Options */
    ioctl(ufd, UI_SET_KEYBIT, BTN_THUMBL);  /* L3 */
    ioctl(ufd, UI_SET_KEYBIT, BTN_THUMBR);  /* R3 */
    ioctl(ufd, UI_SET_KEYBIT, BTN_MODE);    /* Home / Guide */

    /* Axes — sticks (0-255, center 128) */
    set_abs(ufd, ABS_X,  0, 255, 8, 4);    /* Left stick X */
    set_abs(ufd, ABS_Y,  0, 255, 8, 4);    /* Left stick Y */
    set_abs(ufd, ABS_RX, 0, 255, 8, 4);    /* Right stick X */
    set_abs(ufd, ABS_RY, 0, 255, 8, 4);    /* Right stick Y */

    /* Axes — triggers (0-255) */
    set_abs(ufd, ABS_Z,  0, 255, 0, 0);    /* L2 analog */
    set_abs(ufd, ABS_RZ, 0, 255, 0, 0);    /* R2 analog */

    /* Axes — hat/d-pad (-1 to 1) */
    set_abs(ufd, ABS_HAT0X, -1, 1, 0, 0);  /* D-pad X */
    set_abs(ufd, ABS_HAT0Y, -1, 1, 0, 0);  /* D-pad Y */

    struct uinput_setup setup = {0};
    int player = 1;
    if (argc > 1) player = atoi(argv[1]);
    if (player < 1 || player > 4) player = 1;

    setup.id.bustype = BUS_VIRTUAL;
    setup.id.vendor = 0x045e;   /* Microsoft — so games recognize it as Xbox-like */
    setup.id.product = 0x028e;  /* Xbox 360 controller */
    setup.id.version = player;
    snprintf(setup.name, sizeof(setup.name), "Virtual Gamepad %d", player);

    if (ioctl(ufd, UI_DEV_SETUP, &setup) < 0) { perror("UI_DEV_SETUP"); return 1; }
    if (ioctl(ufd, UI_DEV_CREATE) < 0) { perror("UI_DEV_CREATE"); return 1; }

    fprintf(stderr, "uinput-gamepad: device created\n");
    fflush(stderr);

    /* Read input_event structs from stdin and forward to uinput */
    struct input_event ev;
    while (1) {
        ssize_t n = read(0, &ev, sizeof(ev));
        if (n <= 0) break;
        if (n == sizeof(ev)) {
            write(ufd, &ev, sizeof(ev));
        }
    }

    cleanup(0);
    return 0;
}
