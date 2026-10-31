FROM docker.io/trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b

USER root
COPY requirements.txt /opt/dsbot/requirements.txt
RUN /opt/venv/bin/python3 -m pip install --no-deps --require-hashes -r /opt/dsbot/requirements.txt \
    && test "$(cua-driver --version)" = "cua-driver 0.37.0"
COPY launch.py /opt/dsbot/launch.py
LABEL org.ds-bot.computer.protocol="1"
LABEL org.ds-bot.computer.driver="0.37.0"
USER 1000:1000
ENV HOME=/home/cua DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/dsbot-runtime
ENV CUA_DRIVER_RS_TELEMETRY_ENABLED=0 CUA_DRIVER_INSTALL_CHANNEL=python_package
ENTRYPOINT ["/opt/venv/bin/python3", "/opt/dsbot/launch.py"]
